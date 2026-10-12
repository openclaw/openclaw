import { posix } from "node:path";
import { isNodeTestEvidencePath, parseNodeFailureReport } from "./lib/ci-node-test-evidence.mjs";
import { isStaticEvidencePath, parseStaticFailureReport } from "./lib/ci-static-check-evidence.mjs";

const SHA = /^[a-f0-9]{40}$/u;

function staticCheck(jobName, stepName, requireComplete = false) {
  if (
    (/^check-test-types-core-\d+$/u.test(jobName) &&
      stepName === "Run hosted core test-types stripe") ||
    (["check-prod-types", "check-test-types"].includes(jobName) && stepName === "Run check shard")
  ) {
    return "tsgo";
  }
  if (
    requireComplete &&
    !(
      (/^check-lint-core-\d+$/u.test(jobName) && stepName === "Run hosted core lint stripe") ||
      (/^check-lint-extensions-\d+$/u.test(jobName) &&
        stepName === "Run hosted extension lint stripe")
    )
  ) {
    return null;
  }
  if (
    (jobName === "check-lint" && ["Run check shard", "Run changed lint"].includes(stepName)) ||
    (/^check-lint-core-\d+$/u.test(jobName) &&
      ["Run hosted core lint stripe", "Run changed lint"].includes(stepName)) ||
    (/^check-lint-extensions-\d+$/u.test(jobName) &&
      ["Run hosted extension lint stripe", "Run changed lint"].includes(stepName))
  ) {
    return "oxlint";
  }
  return null;
}

function client({ repository, token }) {
  if (repository !== "openclaw/openclaw" || !token) {
    throw new Error("Invalid main CI evidence context");
  }
  return async (route, text = false) => {
    const response = await fetch(`https://api.github.com/repos/${repository}${route}`, {
      headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new Error(`Main CI evidence unavailable: HTTP ${response.status}`);
    }
    const body = await response.text();
    if (body.length > 16 * 1024 * 1024) {
      throw new Error("Main CI evidence exceeds its bound");
    }
    return text ? body : JSON.parse(body);
  };
}

function scheduledRun(run, repository) {
  return (
    Number.isSafeInteger(run?.id) &&
    Number.isSafeInteger(run.run_attempt) &&
    run.run_attempt > 0 &&
    run.event === "schedule" &&
    run.path === ".github/workflows/ci.yml" &&
    run.head_branch === "main" &&
    SHA.test(run.head_sha) &&
    run.repository?.full_name === repository &&
    run.head_repository?.full_name === repository &&
    run.status === "completed"
  );
}

async function latestMainRuns(api, repository) {
  const result = await api(
    "/actions/workflows/ci.yml/runs?event=schedule&branch=main&status=completed&per_page=100",
  );
  if (!Array.isArray(result.workflow_runs)) {
    throw new Error("Missing scheduled CI inventory");
  }
  // Never substitute a dispatch, a PR artifact, or an older usable red for the
  // latest completed hourly run. Unrecognized evidence keeps the PR blocking.
  const runs = result.workflow_runs.toSorted((a, b) => b.run_number - a.run_number);
  if (runs.some((run) => !scheduledRun(run, repository))) {
    throw new Error("Untrusted scheduled CI inventory");
  }
  return runs;
}

async function runJobs(api, run) {
  const jobs = new Map();
  for (let page = 1; page <= 4; page++) {
    const body = await api(
      `/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100&page=${page}`,
    );
    if (
      !Number.isSafeInteger(body.total_count) ||
      body.total_count > 400 ||
      !Array.isArray(body.jobs)
    ) {
      throw new Error("Incomplete CI job inventory");
    }
    for (const job of body.jobs) {
      if (
        job.run_id !== run.id ||
        job.run_attempt !== run.run_attempt ||
        !Number.isSafeInteger(job.id)
      ) {
        throw new Error("CI job identity changed");
      }
      jobs.set(job.id, job);
    }
    if (page * 100 >= body.total_count) {
      if (jobs.size !== body.total_count) {
        throw new Error("Incomplete CI job inventory");
      }
      return [...jobs.values()];
    }
  }
  throw new Error("Oversized CI job inventory");
}

async function jobFailures(api, job, requireComplete = true) {
  if (job.status !== "completed" || job.conclusion !== "failure" || !Array.isArray(job.steps)) {
    return [];
  }
  const failed = job.steps.filter((step) => step.conclusion === "failure");
  if (failed.length !== 1) {
    return [];
  }
  const nodeTest = failed[0].name === "Run Node test shard" && job.name.startsWith("checks-node-");
  const kind = staticCheck(job.name, failed[0].name, requireComplete);
  if (!nodeTest && !kind) {
    return [];
  }
  const log = await api(`/actions/jobs/${job.id}/logs`, true);
  return nodeTest
    ? parseNodeFailureReport(log, requireComplete)
    : parseStaticFailureReport(log, kind, requireComplete);
}

async function readMainFailures(api, run) {
  const jobs = await runJobs(api, run);
  const signatures = [];
  for (const job of jobs) {
    signatures.push(...(await jobFailures(api, job, false)));
  }
  return signatures;
}

async function pullFacts(api, options) {
  const pull = await api(`/pulls/${options.pullRequestNumber}`);
  if (
    pull.state !== "open" ||
    pull.draft ||
    pull.head?.sha !== options.headSha ||
    pull.head?.repo?.full_name !== (options.headRepository ?? options.repository) ||
    pull.base?.repo?.full_name !== options.repository ||
    pull.base?.ref !== "main"
  ) {
    throw new Error("PR identity changed");
  }
  const files = [];
  for (let page = 1; page <= 30; page++) {
    const batch = await api(`/pulls/${options.pullRequestNumber}/files?per_page=100&page=${page}`);
    if (!Array.isArray(batch)) {
      throw new Error("Missing PR diff");
    }
    files.push(...batch);
    if (batch.length < 100) {
      if (files.length !== pull.changed_files) {
        throw new Error("Incomplete PR diff");
      }
      return {
        pull,
        files: files.flatMap((file) => [file.filename, file.previous_filename].filter(Boolean)),
      };
    }
  }
  throw new Error("PR diff exceeds evidence bound");
}

async function untouched(api, ref, files, signatures) {
  // Changes to the execution environment can forge output or change behavior
  // outside a test's direct subjects. They never receive a main-red exception.
  if (
    files.some(
      (file) =>
        /^(?:\.github\/|scripts\/|config\/|test\/vitest\/)/u.test(file) ||
        !file.includes("/") ||
        /(?:^|\/)(?:package\.json|[^/]*lock[^/]*|tsconfig[^/]*|vitest[^/]*)$/u.test(file),
    )
  ) {
    return false;
  }
  const packages = new Map();
  for (const file of new Set(signatures.map((signature) => signature.file))) {
    if (
      signatures.some(
        (signature) =>
          signature.file === file &&
          !(signature.kind === "vitest"
            ? isNodeTestEvidencePath(file)
            : ["tsgo", "oxlint"].includes(signature.kind) && isStaticEvidencePath(file)),
      )
    ) {
      return false;
    }
    const source = await api(`/contents/${file}?ref=${ref}`);
    if (
      source.type !== "file" ||
      source.encoding !== "base64" ||
      typeof source.content !== "string"
    ) {
      return false;
    }
    const text = Buffer.from(source.content, "base64").toString("utf8");
    // Workspace aliases are direct subjects only after their immutable main
    // manifest proves package identity. Guard the whole package, including exports.
    const subjects = new Set([`${posix.dirname(file)}/`]);
    const aliases = new Map();
    for (const match of text.matchAll(/(["'])(@openclaw\/([a-z0-9-]+)(?:\/[^"'\\\s]+)?)\1/gu)) {
      const packageName = `@openclaw/${match[3]}`;
      const directory = `packages/${match[3]}/`;
      if (match[2].split("/").some((part) => part === "." || part === "..")) {
        return false;
      }
      if (!packages.has(packageName)) {
        const manifest = await api(`/contents/${directory}package.json?ref=${ref}`);
        packages.set(
          packageName,
          manifest.type === "file" &&
            manifest.encoding === "base64" &&
            typeof manifest.content === "string" &&
            JSON.parse(Buffer.from(manifest.content, "base64").toString("utf8")).name ===
              packageName,
        );
      }
      if (!packages.get(packageName)) {
        return false;
      }
      subjects.add(directory);
      aliases.set(match[0], `${match[1]}./workspace-subject${match[1]}`);
    }
    let checkedText = text;
    for (const [alias, resolved] of aliases) {
      checkedText = checkedText.replaceAll(alias, resolved);
    }
    // An unresolved alias or computed import has no proven direct subject.
    if (
      /["'](?:@[^"'\s]+\/|openclaw\/|#[^"'\s]+)/u.test(checkedText) ||
      /(?:from\s*|import\s*(?:\()?|require\s*\(|(?:vi\s*\.\s*)?(?:mock|doMock|unmock|doUnmock|importActual|importMock)\s*\()\s*["'](?!\.{1,2}\/|node:|vitest["'])/u.test(
        checkedText,
      ) ||
      /(?:import|require|(?:vi\s*\.\s*)?(?:mock|doMock|unmock|doUnmock|importActual|importMock))\s*\(\s*[^"'\s]/u.test(
        text,
      ) ||
      /(?:import|require|(?:vi\s*\.\s*)?(?:mock|doMock|unmock|doUnmock|importActual|importMock))\s*\(\s*(?:"[^"\n]*"|'[^'\n]*')\s*[^,\s)]/u.test(
        text,
      ) ||
      /(?:from|import|require|(?:vi\s*\.\s*)?(?:mock|doMock|unmock|doUnmock|importActual|importMock))\s*\/[/*]/u.test(
        text,
      )
    ) {
      return false;
    }
    // A directory guard deliberately over-approximates direct subjects. Local
    // imports and mocks can reach sibling owners outside that directory too.
    for (const match of text.matchAll(/["'](\.{1,2}\/[^"'\n]+)["']/gu)) {
      const resolved = posix.normalize(posix.join(posix.dirname(file), match[1]));
      const subject = posix.dirname(resolved);
      if (match[1].includes("\\") || resolved.startsWith("../") || subject === ".") {
        return false;
      }
      subjects.add(`${subject}/`);
    }
    if (files.some((changed) => [...subjects].some((subject) => changed.startsWith(subject)))) {
      return false;
    }
  }
  return true;
}

export function createKnownMainRed(options) {
  const api = client(options);
  let evidence;
  const baseline = async () => {
    const [run] = await latestMainRuns(api, options.repository);
    if (!run || run.conclusion === "success") {
      return null;
    }
    const { files } = await pullFacts(api, options);
    const main = await api("/git/ref/heads/main");
    if (!SHA.test(main.object?.sha)) {
      return null;
    }
    const comparison = await api(`/compare/${main.object.sha}...${options.headSha}`);
    const base = comparison.merge_base_commit?.sha;
    if (!SHA.test(base)) {
      return null;
    }
    const age = await api(`/compare/${base}...${run.head_sha}`);
    if (
      age.status !== "ahead" &&
      !(age.status === "identical" && run.head_sha === main.object.sha)
    ) {
      return null;
    }
    if (run.head_sha !== main.object.sha) {
      const since = await api(`/compare/${run.head_sha}...${main.object.sha}`);
      // A newer main fix must retire the exemption before the next hourly run.
      // Compare returns at most 300 files; a saturated inventory is unproven.
      if (
        since.status !== "ahead" ||
        !Array.isArray(since.files) ||
        since.files.length >= 300 ||
        since.files.some((file) => typeof file.filename !== "string")
      ) {
        return null;
      }
      files.push(
        ...since.files.flatMap((file) => [file.filename, file.previous_filename].filter(Boolean)),
      );
    }
    const failures = await readMainFailures(api, run);
    return {
      run,
      files,
      signatures: new Set(failures.map((entry) => JSON.stringify(entry))),
    };
  };
  return {
    canClassifyJob(job) {
      return (
        job.name.startsWith("checks-node-") ||
        [
          "Run check shard",
          "Run hosted core test-types stripe",
          "Run hosted core lint stripe",
          "Run hosted extension lint stripe",
        ].some((step) => staticCheck(job.name, step, true) !== null)
      );
    },
    async classifyJob(job) {
      try {
        const signatures = await jobFailures(api, job);
        if (signatures.length === 0) {
          return { known: false, signatures: [] };
        }
        evidence ??= baseline();
        const main = await evidence;
        if (!main) {
          return { known: false, signatures: [] };
        }
        const known =
          signatures.every((entry) => main.signatures.has(JSON.stringify(entry))) &&
          (await untouched(api, main.run.head_sha, main.files, signatures));
        return { known, signatures, mainRunId: main.run.id };
      } catch {
        return { known: false, signatures: [] };
      }
    },
  };
}
