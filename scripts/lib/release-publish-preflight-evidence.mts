import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  resolveFullReleaseNpmPreflight,
  verifyNpmPreflightProducer,
  verifyReleasePreflightToolingIdentity,
} from "../npm-preflight-tooling-identity.mjs";
import { validatePreparedCorePackages } from "../npm-prepared-bundle.mjs";
import { validateNpmPreflightDistTag } from "../openclaw-npm-extended-stable-release.mjs";
import { validatePluginSdkApiReleaseEvidence } from "../plugin-sdk-api-release-evidence.mjs";
import { createReleaseEvidenceClient } from "../release-ci-summary.mjs";
import {
  inspectActionsArtifactZipWithPolicy,
  readBoundedRegularFile,
} from "./actions-artifact-archive.mjs";
import corePackagePolicy from "./npm-core-release-packages.json" with { type: "json" };
import {
  fetchNpmRegistryPackumentWithRetry,
  fetchNpmRegistryTarballWithRetry,
} from "./npm-publish-plan.mjs";
import { isRecord, trimString } from "./record-shared.mjs";
import type { ReleasePublishGate } from "./release-publish-gates.mts";

export type PublishPreflightGh = (args: string[]) => string;
export type PublishPreflightRecord = Record<string, unknown>;
type CoreTarball = {
  packageName: string;
  packageVersion: string;
  tarballName: string;
  tarballSha256: string;
};

function tarballDigest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function verifyPreflightCorePackages(
  manifest: PublishPreflightRecord,
  files: Map<string, Buffer>,
  sourceSha: string,
): CoreTarball[] {
  // Older frozen candidates legitimately have no core package field. A present
  // malformed inventory must still fail exactly as the core publisher does.
  const corePackages: CoreTarball[] = validatePreparedCorePackages(
    Object.hasOwn(manifest, "corePackageTarballs") ? manifest.corePackageTarballs : [],
    manifest.packageVersion,
  );
  for (const entry of corePackages) {
    const bytes = files.get(entry.tarballName);
    if (!bytes || tarballDigest(bytes) !== entry.tarballSha256) {
      throw new Error(`Prepared ${entry.packageName} tarball is missing or has a digest mismatch.`);
    }
  }
  if (corePackages.length) {
    const checksums = files.get("core-packages-SHA256SUMS")?.toString("utf8").trim();
    if (!checksums) {
      throw new Error("Prepared core package checksums are missing.");
    }
    for (const line of checksums.split(/\r?\n/u)) {
      const match = /^([a-f0-9]{64}) [ *]([^\r\n]+)$/u.exec(line);
      const bytes = match && files.get(match[2]!);
      if (!match || !bytes || tarballDigest(bytes) !== match[1]) {
        throw new Error("Prepared core package checksum verification failed.");
      }
    }
  }
  const git = (args: string[]) =>
    execFileSync("git", args, {
      encoding: "utf8",
      env: { ...process.env, GIT_NO_LAZY_FETCH: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
      maxBuffer: 8 * 1024 * 1024,
    });
  const sourcePaths = new Set(
    git(["ls-tree", "-r", "--name-only", "-z", sourceSha, "--", "package.json", "packages"]).split(
      "\0",
    ),
  );
  const readPackage = (path: string) =>
    requirePreflightRecord(JSON.parse(git(["show", `${sourceSha}:${path}`])), path);
  const root = readPackage("package.json");
  if (root.version !== manifest.packageVersion) {
    throw new Error("Prepared core package version does not match the exact release source.");
  }
  const dependencies = isRecord(root.dependencies) ? root.dependencies : {};
  const dependencyTarballs = manifest.dependencyTarballs ?? [];
  if (!Array.isArray(dependencyTarballs)) {
    throw new Error("Prepared dependency tarball metadata is invalid.");
  }
  for (const policy of corePackagePolicy) {
    const packagePath = `${policy.path}/package.json`;
    const pkg = sourcePaths.has(packagePath) ? readPackage(packagePath) : undefined;
    const release =
      isRecord(pkg?.openclaw) && isRecord(pkg.openclaw.release) ? pkg.openclaw.release : undefined;
    const required = policy.dependency
      ? Boolean(dependencies[policy.dependency])
      : release?.publishToNpm === true;
    const prepared = corePackages.find((entry) => entry.packageName === policy.name);
    const dependency = dependencyTarballs.find(
      (entry: unknown) => isRecord(entry) && entry.packageName === policy.name,
    );
    const prefix = `${policy.name.replace(/^@/u, "").replace("/", "-")}-`;
    const hasTarball = [...files.keys()].some(
      (name) => name.startsWith(prefix) && name.endsWith(".tgz"),
    );
    if (
      required &&
      (!prepared || (policy.dependency && !isDeepStrictEqual(prepared, dependency)))
    ) {
      throw new Error(
        `Prepared ${policy.name} tarball is missing from the manifest or dependency inventory.`,
      );
    }
    if (!required && (prepared || dependency || hasTarball)) {
      throw new Error(
        `Frozen target without a publishable ${policy.name} package contains unexpected artifacts.`,
      );
    }
    if (required && pkg?.version !== root.version) {
      throw new Error(`Core package version mismatch: ${policy.name}.`);
    }
  }
  return corePackages;
}

export async function verifyPublishedPreflightTarball(input: {
  packageName: string;
  version: string;
  tarballSha256: string;
}): Promise<string> {
  if (!/^[a-f0-9]{64}$/u.test(input.tarballSha256)) {
    throw new Error("Invalid preflight tarball SHA-256.");
  }
  const result = await fetchNpmRegistryPackumentWithRetry({
    packageName: input.packageName,
    packageUrl: `https://registry.npmjs.org/${encodeURIComponent(input.packageName)}`,
    maxBytes: 16 * 1024 * 1024,
  });
  if (!result.ok) {
    throw new Error(`Published ${input.packageName} registry read returned HTTP ${result.status}.`);
  }
  const registry = requirePreflightRecord(result.packument, "npm package inventory");
  const versions = requirePreflightRecord(registry.versions, "npm package versions");
  const version = requirePreflightRecord(versions[input.version], "published npm version");
  if (
    registry.name !== input.packageName ||
    version.name !== input.packageName ||
    version.version !== input.version
  ) {
    throw new Error("Published npm package identity differs from the selected preflight package.");
  }
  const dist = requirePreflightRecord(version.dist, "published npm distribution");
  if (typeof dist.tarball !== "string") {
    throw new Error("Published npm tarball URL is missing.");
  }
  const url = new URL(dist.tarball);
  if (url.origin !== "https://registry.npmjs.org" || url.username || url.password) {
    throw new Error("Published npm tarball must use the canonical registry origin.");
  }
  const bytes = await fetchNpmRegistryTarballWithRetry({
    packageName: input.packageName,
    packageUrl: url.href,
    maxBytes: 192 * 1024 * 1024,
  });
  if (tarballDigest(bytes) !== input.tarballSha256) {
    throw new Error(
      `${input.packageName}@${input.version} is already published with bytes different from this preflight; cut a correction tag instead of resuming.`,
    );
  }
  return createHash("sha512").update(bytes).digest("hex");
}

export function requirePreflightRecord(value: unknown, label: string): PublishPreflightRecord {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

export function createPublishPreflightGh(): PublishPreflightGh {
  const responses = new Map<string, string>();
  return (args) => {
    const key = JSON.stringify(args);
    let response = responses.get(key);
    if (response === undefined) {
      response = execFileSync("gh", args, {
        encoding: "utf8",
        timeout: 60_000,
        maxBuffer: 32 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      });
      responses.set(key, response);
    }
    return response;
  };
}

export function preflightApi(runGh: PublishPreflightGh, repo: string, endpoint: string): unknown {
  return JSON.parse(
    runGh(["api", `repos/${repo}${endpoint ? `/${endpoint}` : ""}`, "--method", "GET"]),
  );
}

export function readPublishPreflightRelease(runGh: PublishPreflightGh, repo: string, tag: string) {
  // The tag endpoint omits drafts, and gh release view can mask a failed draft
  // lookup as absence. One bounded list owner preserves errors and shared caching.
  for (let page = 1; page <= 20; page++) {
    const releases = preflightApi(runGh, repo, `releases?per_page=100&page=${page}`);
    if (
      !Array.isArray(releases) ||
      releases.length > 100 ||
      !releases.every(
        (release): release is PublishPreflightRecord =>
          isRecord(release) && typeof release.tag_name === "string",
      )
    ) {
      throw new Error("Invalid GitHub release inventory.");
    }
    const release = releases.find((entry) => entry.tag_name === tag);
    if (release) {
      if (
        typeof release.id !== "number" ||
        typeof release.draft !== "boolean" ||
        typeof release.prerelease !== "boolean" ||
        typeof release.html_url !== "string" ||
        typeof release.target_commitish !== "string"
      ) {
        throw new Error("Invalid GitHub release response.");
      }
      return {
        state: "found" as const,
        release: {
          id: release.id,
          draft: release.draft,
          prerelease: release.prerelease,
          tag_name: tag,
          html_url: release.html_url,
          target_commitish: release.target_commitish,
          body: release.body,
          assets: release.assets,
        },
      };
    }
    if (releases.length < 100) {
      // GitHub includes drafts only for readers with push access. A complete
      // public-only list cannot establish that publication has no existing draft.
      const repository = requirePreflightRecord(preflightApi(runGh, repo, ""), "repository");
      if (!isRecord(repository.permissions) || repository.permissions.push !== true) {
        return {
          state: "unresolved" as const,
          message:
            "No matching visible release; repository push access to see drafts could not be verified.",
        };
      }
      return { state: "absent" as const };
    }
  }
  throw new Error(
    "GitHub release inventory exceeds the bounded lookup; release state is unresolved.",
  );
}

export function inspectPublishPreflightTelegramEvidence(input: {
  repo: string;
  runId: string;
  workflowRef: string;
  runGh: PublishPreflightGh;
}): ReleasePublishGate {
  try {
    if (!/^[1-9][0-9]*$/u.test(input.runId)) {
      throw new Error("npm_telegram_run_id must be a positive GitHub Actions run id.");
    }
    const run = requirePreflightRecord(
      preflightApi(input.runGh, input.repo, `actions/runs/${input.runId}`),
      "NPM Telegram Beta E2E run",
    );
    const allowedBranches = ["main", input.workflowRef];
    for (const [field, allowed] of [
      ["name", ["NPM Telegram Beta E2E"]],
      ["event", ["workflow_dispatch"]],
      ["head_branch", allowedBranches],
      ["status", ["completed"]],
    ] as const) {
      const observed = trimString(run[field]);
      if (!allowed.some((value) => value === observed)) {
        throw new Error(
          `NPM Telegram Beta E2E: run ${input.runId} ${field} is ${observed || "<missing>"}, expected ${allowed.join(" or ")}.`,
        );
      }
    }
    // The postpublish verifier requires a completed, correctly identified run,
    // but retains an unsuccessful conclusion as advisory evidence.
    const conclusion = trimString(run.conclusion) || "unavailable";
    return {
      id: "npm-telegram.evidence",
      status: conclusion === "success" ? "PASS" : "WARN",
      message: `NPM Telegram Beta E2E run ${input.runId} is completed/${conclusion}.`,
      remediation:
        conclusion === "success"
          ? ""
          : `Inspect the advisory result at https://github.com/${input.repo}/actions/runs/${input.runId}; its conclusion does not block publication.`,
    };
  } catch (error) {
    return {
      id: "npm-telegram.evidence",
      status: "FAIL",
      message: error instanceof Error ? error.message : String(error),
      remediation:
        "Supply a completed NPM Telegram Beta E2E workflow_dispatch run from main or the selected publication tooling ref, or omit the optional npm_telegram_run_id.",
    };
  }
}

export function createPublishPreflightEvidenceClient(repo: string) {
  const client = createReleaseEvidenceClient(repo);
  const manifests = new Map<string, ReturnType<typeof client.loadManifest>>();
  return {
    ...client,
    // Authentication and both publication consumers use the same authenticated
    // artifact bytes. Never download a second current-parent manifest.
    loadManifest(runId: string, runAttempt: number, manifestPath?: string) {
      const key = `${runId}/${runAttempt}`;
      if (!manifests.has(key)) {
        manifests.set(key, client.loadManifest(runId, runAttempt, manifestPath));
      }
      return manifests.get(key);
    },
  };
}

export function resolvePreflightTag(runGh: PublishPreflightGh, repo: string, tag: string): string {
  let object = requirePreflightRecord(
    requirePreflightRecord(preflightApi(runGh, repo, `git/ref/tags/${encodeURI(tag)}`), "tag")
      .object,
    "tag object",
  );
  if (object.type === "tag") {
    object = requirePreflightRecord(
      requirePreflightRecord(
        preflightApi(runGh, repo, `git/tags/${String(object.sha)}`),
        "annotated tag",
      ).object,
      "annotated tag target",
    );
  }
  if (
    object.type !== "commit" ||
    typeof object.sha !== "string" ||
    !/^[a-f0-9]{40}$/u.test(object.sha)
  ) {
    throw new Error(`Tag ${tag} does not resolve to one exact commit.`);
  }
  return object.sha;
}

export function ensureReleasePublishToolingTag({
  runGh,
  repo,
  toolingSha,
  now = Date.now,
}: {
  runGh: PublishPreflightGh;
  repo: string;
  toolingSha: string;
  now?: () => number;
}): { tag: string; created: boolean } {
  if (!/^[a-f0-9]{40}$/u.test(toolingSha)) {
    throw new Error("Tooling SHA must be a lowercase 40-character commit SHA.");
  }
  const ancestry = runGh([
    "api",
    `repos/${repo}/compare/${toolingSha}...main`,
    "--method",
    "GET",
    "--jq",
    ".status",
  ]).trim();
  if (ancestry !== "ahead" && ancestry !== "identical") {
    throw new Error(`Tooling SHA ${toolingSha} is not reachable from trusted main.`);
  }
  const sha12 = toolingSha.slice(0, 12);
  const refs = preflightApi(runGh, repo, `git/matching-refs/tags/release-publish/${sha12}-`);
  if (!Array.isArray(refs)) {
    throw new Error("Invalid protected tooling tag inventory.");
  }
  let newest: RegExpExecArray | undefined;
  for (const entry of refs) {
    if (
      !isRecord(entry) ||
      !isRecord(entry.object) ||
      entry.object.type !== "commit" ||
      entry.object.sha !== toolingSha ||
      typeof entry.ref !== "string"
    ) {
      continue;
    }
    const match = /^refs\/tags\/(release-publish\/[a-f0-9]{12}-([1-9][0-9]*))$/u.exec(entry.ref);
    if (match && (!newest || BigInt(match[2]!) > BigInt(newest[2]!))) {
      newest = match;
    }
  }
  if (newest) {
    return { tag: newest[1]!, created: false };
  }
  const tag = `release-publish/${sha12}-${Math.floor(now() / 1000)}`;
  runGh([
    "api",
    `repos/${repo}/git/refs`,
    "--method",
    "POST",
    "-f",
    `ref=refs/tags/${tag}`,
    "-f",
    `sha=${toolingSha}`,
  ]);
  if (resolvePreflightTag(runGh, repo, tag) !== toolingSha) {
    throw new Error(`Protected tooling tag ${tag} does not resolve to ${toolingSha}.`);
  }
  return { tag, created: true };
}

function listPreflightArtifacts(runGh: PublishPreflightGh, repo: string, runId: string) {
  const artifacts: PublishPreflightRecord[] = [];
  for (let page = 1; page <= 20; page++) {
    const result = requirePreflightRecord(
      preflightApi(runGh, repo, `actions/runs/${runId}/artifacts?per_page=100&page=${page}`),
      "artifact inventory",
    );
    if (!Array.isArray(result.artifacts)) {
      throw new Error("Invalid artifact inventory.");
    }
    artifacts.push(...result.artifacts.map((entry) => requirePreflightRecord(entry, "artifact")));
    if (artifacts.length === result.total_count) {
      return artifacts;
    }
    if (result.artifacts.length < 100) {
      break;
    }
  }
  throw new Error("Artifact inventory is incomplete; retry after GitHub inventory settles.");
}

function readPreflightArchive(repo: string, artifact: PublishPreflightRecord) {
  if (
    artifact.expired !== false ||
    typeof artifact.digest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/u.test(artifact.digest) ||
    typeof artifact.id !== "number" ||
    !Number.isSafeInteger(artifact.id) ||
    artifact.id < 1 ||
    typeof artifact.size_in_bytes !== "number" ||
    !Number.isSafeInteger(artifact.size_in_bytes) ||
    artifact.size_in_bytes < 1 ||
    artifact.size_in_bytes > 256 * 1024 * 1024
  ) {
    throw new Error(
      "Preflight artifact must be unexpired with an immutable digest and bounded size.",
    );
  }
  const archive = execFileSync(
    "gh",
    ["api", `repos/${repo}/actions/artifacts/${artifact.id}/zip`],
    {
      timeout: 240_000,
      maxBuffer: 256 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (
    archive.length !== artifact.size_in_bytes ||
    `sha256:${createHash("sha256").update(archive).digest("hex")}` !== artifact.digest
  ) {
    throw new Error("Preflight artifact archive size or digest differs from GitHub metadata.");
  }
  return inspectActionsArtifactZipWithPolicy(archive, {
    minEntries: 1,
    maxEntries: 1024,
    allowPath: (name: string) =>
      /^[A-Za-z0-9_.-]+\.(?:tgz|json|txt)$|^core-packages-SHA256SUMS$|^dependency-evidence\/[A-Za-z0-9_.-]+\.(?:json|md)$/u.test(
        name,
      ),
    maxEntryBytes: (name: string) => (name.endsWith(".tgz") ? 192 : 17) * 1024 * 1024,
  });
}

export function validatePublishPreflightNpm(
  options: {
    repo: string;
    tag: string;
    targetSha: string;
    toolingSha: string;
    workflowRef: string;
    npmDistTag: string;
    preflightRunId: string;
    fullReleaseValidationRunId: string;
    fullReleaseValidationRunAttempt: string;
    fullManifest?: PublishPreflightRecord;
    pluginSdkApiAcknowledgement: string;
    currentSelectorRef: string;
    currentSelectorSha: string;
    runGh: PublishPreflightGh;
  },
  context: {
    npmManifest?: PublishPreflightRecord;
    npmManifestPath?: string;
    npmPreflightRun?: PublishPreflightRecord;
  } = {},
) {
  const { repo, runGh } = options;
  const qualified =
    options.preflightRunId === options.fullReleaseValidationRunId
      ? resolveFullReleaseNpmPreflight({
          manifest: options.fullManifest,
          repository: repo,
          runId: options.fullReleaseValidationRunId,
          runAttempt: options.fullReleaseValidationRunAttempt,
          sourceSha: options.targetSha,
          toolingSha: String(options.fullManifest?.workflowSha),
          runGh,
        })
      : undefined;
  const run =
    qualified?.run ??
    requirePreflightRecord(
      preflightApi(runGh, repo, `actions/runs/${options.preflightRunId}`),
      "npm preflight run",
    );
  const producerRunId = String(run.id);
  const workflowPath = String(run.path).split("@", 1)[0];
  if (
    run.status !== "completed" ||
    run.conclusion !== "success" ||
    run.event !== "workflow_dispatch" ||
    (!qualified && workflowPath !== ".github/workflows/openclaw-npm-release.yml")
  ) {
    throw new Error("Npm preflight producer must be a successful canonical workflow dispatch.");
  }
  const branch = String(run.head_branch);
  const sha = String(run.head_sha);
  if (branch.startsWith("release-publish/")) {
    verifyReleasePreflightToolingIdentity({
      repository: repo,
      publisherSha: options.toolingSha,
      workflowFullRef: `refs/tags/${branch}`,
      workflowRef: branch,
      workflowSha: sha,
      runGh,
    });
  } else if (!qualified && branch !== "main" && branch !== options.workflowRef) {
    throw new Error(
      "Npm preflight must come from main, the active protected branch, or a verified protected tag.",
    );
  }
  const comparison = requirePreflightRecord(
    preflightApi(runGh, repo, `compare/${sha}...${options.toolingSha}?per_page=1`),
    "preflight tooling ancestry",
  );
  if (comparison.status !== "ahead" && comparison.status !== "identical") {
    throw new Error("Npm preflight tooling is not on the selected publisher lineage.");
  }
  let manifest = context.npmManifest;
  let manifestSha256: string | undefined;
  let files: Map<string, Buffer>;
  if (!manifest) {
    const artifacts = listPreflightArtifacts(runGh, repo, producerRunId);
    const candidates = artifacts.filter(
      (item) => item.expired === false && String(item.name).startsWith("openclaw-npm-preflight-"),
    );
    const preferred = candidates.filter(
      (item) => item.name === `openclaw-npm-preflight-${options.tag}`,
    );
    const selected = qualified ? [qualified.artifact] : preferred.length ? preferred : candidates;
    const sdk = artifacts.filter(
      (item) =>
        item.expired === false &&
        item.name === `plugin-sdk-api-release-diff-${producerRunId}-${run.run_attempt}`,
    );
    if (selected.length !== 1 || sdk.length !== 1) {
      throw new Error(
        "Expected one npm preflight artifact and one immutable Plugin SDK evidence artifact.",
      );
    }
    files = readPreflightArchive(repo, selected[0]);
    const manifestBytes = files.get("preflight-manifest.json");
    if (!manifestBytes) {
      throw new Error("Npm preflight manifest is missing from the artifact.");
    }
    manifestSha256 = createHash("sha256").update(manifestBytes).digest("hex");
    manifest = requirePreflightRecord(
      JSON.parse(manifestBytes.toString("utf8")),
      "npm preflight manifest",
    );
    const sdkBytes = readPreflightArchive(repo, sdk[0]!).get(
      "plugin-sdk-api-release-evidence.json",
    );
    if (
      !sdkBytes ||
      !isDeepStrictEqual(manifest.pluginSdkApi, JSON.parse(sdkBytes.toString("utf8")))
    ) {
      throw new Error("Npm preflight SDK evidence differs from its immutable artifact.");
    }
  } else {
    if (!context.npmManifestPath) {
      throw new Error("Reused npm evidence requires its authenticated manifest path.");
    }
    const bytes = readBoundedRegularFile(context.npmManifestPath, {
      label: "reused npm preflight manifest",
      maxBytes: 17 * 1024 * 1024,
    });
    if (!isDeepStrictEqual(manifest, JSON.parse(bytes.toString("utf8")))) {
      throw new Error("Reused npm manifest changed after candidate validation.");
    }
    manifestSha256 = createHash("sha256").update(bytes).digest("hex");
    const directory = dirname(context.npmManifestPath);
    files = new Map(
      readdirSync(directory)
        .filter((name) => name.endsWith(".tgz") || name === "core-packages-SHA256SUMS")
        .map((name) => [
          name,
          readBoundedRegularFile(join(directory, name), {
            label: `reused npm artifact ${name}`,
            maxBytes: name.endsWith(".tgz") ? 192 * 1024 * 1024 : 1024 * 1024,
          }),
        ]),
    );
  }
  if (
    manifest.releaseTag !== options.tag ||
    manifest.releaseSha !== options.targetSha ||
    manifest.packageVersion !== options.tag.slice(1)
  ) {
    throw new Error("Npm preflight tag, SHA, or package version differs from the release.");
  }
  const tarball = files.get(String(manifest.tarballName));
  if (!tarball || tarballDigest(tarball) !== manifest.tarballSha256) {
    throw new Error("Npm preflight tarball is missing or has the wrong digest.");
  }
  const corePackages = verifyPreflightCorePackages(manifest, files, options.targetSha);
  verifyNpmPreflightProducer({
    manifest,
    manifestSha256,
    repository: repo,
    workflowFullRef: `refs/${branch.startsWith("release-publish/") ? "tags" : "heads"}/${branch}`,
    workflowSha: sha,
    workflowPath,
    runId: producerRunId,
    runAttempt: String(run.run_attempt),
    fullReleaseManifest: options.fullManifest,
    fullReleaseRunId: options.fullReleaseValidationRunId,
    fullReleaseRunAttempt: options.fullReleaseValidationRunAttempt,
    runGh,
  });
  validateNpmPreflightDistTag({ manifest, npmDistTag: options.npmDistTag });
  validatePluginSdkApiReleaseEvidence({
    evidence: manifest.pluginSdkApi,
    acknowledgement: options.pluginSdkApiAcknowledgement,
    expectedHeadSha: options.targetSha,
    expectedWorkflowSha: sha,
    npmDistTag: options.npmDistTag,
    currentSelectorRef: options.currentSelectorRef,
    currentSelectorSha: options.currentSelectorSha,
    targetRef: options.tag,
  });
  return { manifest, run, corePackages };
}

export function verifyPublishSourceLineage(input: {
  repo: string;
  sourceSha: string;
  workflowRef: string;
  releaseTag: string;
  runGh: PublishPreflightGh;
}) {
  const branches = ["main"];
  for (const prefix of ["release/", "extended-stable/"]) {
    const refs = preflightApi(input.runGh, input.repo, `git/matching-refs/heads/${prefix}`);
    if (!Array.isArray(refs)) {
      throw new Error("Unable to enumerate trusted release branches.");
    }
    branches.push(
      ...refs.map((ref) =>
        String(requirePreflightRecord(ref, "branch ref").ref).replace(/^refs\/heads\//u, ""),
      ),
    );
  }
  if (input.releaseTag.includes("-alpha.") && input.workflowRef.startsWith("tideclaw/alpha/")) {
    branches.push(input.workflowRef);
  }
  for (const branch of branches) {
    const comparison = requirePreflightRecord(
      preflightApi(
        input.runGh,
        input.repo,
        `compare/${input.sourceSha}...${encodeURIComponent(branch)}?per_page=1`,
      ),
      "release source ancestry",
    );
    if (comparison.status === "ahead" || comparison.status === "identical") {
      return branch;
    }
  }
  throw new Error(
    "Release source is not reachable from main, release/*, extended-stable/* or the matching Tideclaw branch.",
  );
}
