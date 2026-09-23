#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { z } from "zod";

type ResumeRunRecord = Partial<
  Record<
    | "conclusion"
    | "event"
    | "head_branch"
    | "head_sha"
    | "html_url"
    | "path"
    | "workflow_id"
    | "run_attempt"
    | "id"
    | "status",
    unknown
  >
>;
type ResumeTagRecord = {
  object?: Partial<Record<"sha" | "type", unknown>>;
  verification?: { verified?: unknown };
};
type ResumeJobRecord = Partial<Record<"conclusion" | "name", unknown>>;
type NpmPublication = { version: string; tarballSha512: string; document: unknown };

export interface OpenClawNpmResumeValidationInput {
  canonicalWorkflowId: unknown;
  compareStatus: unknown;
  jobs: ResumeJobRecord[];
  run: ResumeRunRecord;
  tag: ResumeTagRecord;
  tagRef: ResumeTagRecord;
  trustedWorkflowFullRef: unknown;
  trustedWorkflowRef: unknown;
}

const SHA_PATTERN = /^[a-f0-9]{40}$/u;
const RELEASE_PUBLISH_REF_PATTERN = /^release-publish\/([a-f0-9]{12})-([1-9][0-9]*)$/u;
const WORKFLOW_PATH = ".github/workflows/openclaw-npm-release.yml";
// Resume checks run during release recovery, so keep enough headroom for GitHub
// latency while preventing one stalled read from consuming the workflow budget.
const GH_COMMAND_TIMEOUT_MS = 60_000;
const publicationDocumentSchema = z.object({
  attestations: z.array(
    z.object({
      predicateType: z.string(),
      bundle: z
        .object({
          dsseEnvelope: z.object({ payload: z.string() }).passthrough().optional(),
        })
        .passthrough(),
    }),
  ),
});
const publicationStatementSchema = z.object({
  subject: z.array(z.object({ name: z.string(), digest: z.object({ sha512: z.string() }) })),
  predicate: z.object({
    buildDefinition: z.object({
      externalParameters: z.object({
        workflow: z.object({ ref: z.string(), repository: z.string(), path: z.string() }),
      }),
      resolvedDependencies: z.array(
        z.object({ uri: z.string(), digest: z.object({ gitCommit: z.string() }) }),
      ),
    }),
    runDetails: z.object({ metadata: z.object({ invocationId: z.string() }) }),
  }),
});

function resolvePublishedNpmRun(repo: string, publication: NpmPublication) {
  const document = publicationDocumentSchema.parse(publication.document);
  if (!/^[a-f0-9]{128}$/u.test(publication.tarballSha512)) {
    fail("OpenClaw npm resume requires the exact downloaded tarball's SHA-512.");
  }
  const publishers = new Map<
    string,
    { runId: string; runAttempt: number; workflowRef: string; workflowSha: string }
  >();
  for (const attestation of document.attestations) {
    if (attestation.predicateType !== "https://slsa.dev/provenance/v1") {
      continue;
    }
    const statement = publicationStatementSchema.parse(
      parseJson(
        Buffer.from(attestation.bundle.dsseEnvelope?.payload ?? "", "base64").toString("utf8"),
        "npm publication provenance",
      ),
    );
    if (
      !statement.subject.some(
        (subject) =>
          subject.name === `pkg:npm/openclaw@${publication.version}` &&
          subject.digest.sha512 === publication.tarballSha512,
      )
    ) {
      continue;
    }
    const { buildDefinition, runDetails } = statement.predicate;
    const workflow = buildDefinition.externalParameters.workflow;
    const prefix = `https://github.com/${repo}/actions/runs/`;
    const invocation = runDetails.metadata.invocationId;
    const match = invocation.startsWith(prefix)
      ? /^([1-9][0-9]*)\/attempts\/([1-9][0-9]*)$/u.exec(invocation.slice(prefix.length))
      : null;
    if (
      !match ||
      workflow.repository !== `https://github.com/${repo}` ||
      workflow.path !== WORKFLOW_PATH
    ) {
      fail("Published npm provenance does not identify this repository's npm release workflow.");
    }
    const revisions = new Set(
      buildDefinition.resolvedDependencies
        .filter((dependency) => dependency.uri === `git+${workflow.repository}@${workflow.ref}`)
        .map((dependency) => dependency.digest.gitCommit),
    );
    if (revisions.size !== 1) {
      fail("Published npm provenance has missing or ambiguous workflow revisions.");
    }
    const publisher = {
      runId: requiredString(match[1], "published run id"),
      runAttempt: Number(match[2]),
      workflowRef: workflow.ref,
      workflowSha: requiredSha([...revisions][0], "published workflow SHA"),
    };
    publishers.set(JSON.stringify(publisher), publisher);
  }
  const [publisher] = publishers.values();
  if (publishers.size !== 1 || !publisher) {
    fail(
      "Published npm provenance has missing or ambiguous publisher evidence; preserve the original runs and reconcile before resuming.",
    );
  }
  // Discovery is not authorization: the entrypoint validates the live run and
  // protected tag, then verifies this receipt with the canonical Sigstore policy.
  return publisher;
}

function fail(message: string): never {
  throw new Error(message);
}

function parseJson(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(`${label} returned invalid JSON.`, { cause: error });
  }
}

function resumeRunRecord(value: unknown): ResumeRunRecord {
  return isRecord(value) ? value : {};
}

function resumeTagRecord(value: unknown): ResumeTagRecord {
  if (!isRecord(value)) {
    return {};
  }
  const object = isRecord(value.object)
    ? { sha: value.object.sha, type: value.object.type }
    : undefined;
  const verification = isRecord(value.verification)
    ? { verified: value.verification.verified }
    : undefined;
  return { object, verification };
}

function resumeJobRecords(value: unknown): ResumeJobRecord[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    fail(`OpenClaw npm resume run is missing ${label}.`);
  }
  return value;
}

function requiredSha(value: unknown, label: string): string {
  const sha = requiredString(value, label);
  if (!SHA_PATTERN.test(sha)) {
    fail(`OpenClaw npm resume run has invalid ${label}.`);
  }
  return sha;
}

export function validateOpenClawNpmResumeRun({
  canonicalWorkflowId,
  compareStatus,
  jobs,
  run,
  tag,
  tagRef,
  trustedWorkflowFullRef,
  trustedWorkflowRef,
}: OpenClawNpmResumeValidationInput) {
  const url = requiredString(run?.html_url, "html_url");
  const workflowRef = requiredString(trustedWorkflowRef, "trusted workflow ref");
  const workflowFullRef = requiredString(trustedWorkflowFullRef, "trusted workflow full ref");
  const workflowRefMatch = RELEASE_PUBLISH_REF_PATTERN.exec(workflowRef);
  if (!workflowRefMatch || workflowFullRef !== `refs/tags/${workflowRef}`) {
    fail(`OpenClaw npm resume run has an untrusted workflow ref: ${url}`);
  }

  const branch = requiredString(run?.head_branch, "head_branch");
  const sha = requiredSha(run?.head_sha, "head_sha");
  const path = requiredString(run?.path, "path");
  if (
    run?.conclusion !== "success" ||
    run?.event !== "workflow_dispatch" ||
    path !== WORKFLOW_PATH ||
    run?.workflow_id !== canonicalWorkflowId ||
    branch !== workflowRef ||
    sha.slice(0, 12) !== workflowRefMatch[1]
  ) {
    fail(`OpenClaw npm resume run has an untrusted workflow identity: ${url}`);
  }

  const tagObjectSha = requiredSha(tagRef?.object?.sha, "tooling tag object SHA");
  if (tagRef?.object?.type === "commit") {
    if (tagObjectSha !== sha) {
      fail(`OpenClaw npm resume run protected tooling tag moved after dispatch: ${url}`);
    }
  } else if (tagRef?.object?.type === "tag") {
    const tagCommitSha = requiredSha(tag?.object?.sha, "tooling tag commit SHA");
    if (
      tag?.object?.type !== "commit" ||
      tagCommitSha !== sha ||
      tag?.verification?.verified !== true ||
      (compareStatus !== "ahead" && compareStatus !== "identical")
    ) {
      fail(
        `OpenClaw npm resume run is not bound to a real, main-reachable protected tooling tag: ${url}`,
      );
    }
  } else {
    fail(`OpenClaw npm resume run tooling ref is not a protected tag: ${url}`);
  }

  if (
    !Array.isArray(jobs) ||
    !jobs.some((job) => job?.name === "validate_publish_request" && job?.conclusion === "success")
  ) {
    fail(`OpenClaw npm resume run lacks successful parent release approval validation: ${url}`);
  }

  return {
    url,
    workflowRef: workflowFullRef,
    workflowSha: sha,
    tagObjectSha,
  };
}

export function runOpenClawNpmResumeGh(
  args: string[],
  params: {
    execFileSyncImpl?: typeof runGhCommand;
  } = {},
): string {
  const execFileSyncImpl = params.execFileSyncImpl ?? runGhCommand;
  return execFileSyncImpl("gh", args, {
    encoding: "utf8",
    killSignal: "SIGKILL",
    maxBuffer: 32 * 1024 * 1024,
    timeout: GH_COMMAND_TIMEOUT_MS,
  });
}

function runGhCommand(
  command: string,
  args: string[],
  options: {
    encoding: "utf8";
    killSignal: "SIGKILL";
    maxBuffer: number;
    timeout: number;
  },
) {
  return execFileSync(command, args, options);
}

export function resolveOpenClawNpmResumeRun({
  repo,
  runId: requestedRunId,
  publication,
  runGh = runOpenClawNpmResumeGh,
}: {
  repo: string;
  runId: string;
  publication: NpmPublication;
  runGh?: (args: string[]) => string;
}) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repo)) {
    fail("OpenClaw npm resume repository must be owner/name.");
  }
  const publisher = resolvePublishedNpmRun(repo, publication);
  if (requestedRunId && requestedRunId !== publisher.runId) {
    fail("OpenClaw npm resume run does not match the published package's original publisher.");
  }
  const runId = publisher.runId;
  const trustedWorkflowFullRef = publisher.workflowRef;
  const trustedWorkflowRef = publisher.workflowRef.replace(/^refs\/tags\//u, "");

  const api = (endpoint: string): unknown =>
    parseJson(runGh(["api", `repos/${repo}/${endpoint}`, "--method", "GET"]), endpoint);
  const trustedRefMatch = RELEASE_PUBLISH_REF_PATTERN.exec(trustedWorkflowRef);
  if (!trustedRefMatch || trustedWorkflowFullRef !== `refs/tags/${trustedWorkflowRef}`) {
    fail(
      "OpenClaw npm resume trusted workflow identity must be an exact protected release-publish tag.",
    );
  }

  // The signed invocation identifies the publisher, even if a later rerun
  // changes the run's latest status. Never substitute that mutable projection.
  const run = resumeRunRecord(api(`actions/runs/${runId}/attempts/${publisher.runAttempt}`));
  if (
    run.id !== Number(runId) ||
    run.status !== "completed" ||
    run.head_sha !== publisher.workflowSha ||
    !Number.isSafeInteger(publisher.runAttempt) ||
    run.run_attempt !== publisher.runAttempt
  ) {
    fail("OpenClaw npm resume run no longer matches the published workflow SHA and attempt.");
  }
  const canonicalWorkflow = api(`actions/workflows/${WORKFLOW_PATH.split("/").at(-1)}`);
  const tagRef = resumeTagRecord(api(`git/ref/tags/${trustedWorkflowRef}`));
  const tagObjectSha = requiredSha(tagRef?.object?.sha, "tooling tag object SHA");
  const sha = requiredSha(run?.head_sha, "head_sha");
  const annotatedTag = tagRef?.object?.type === "tag";
  const tag = annotatedTag ? resumeTagRecord(api(`git/tags/${tagObjectSha}`)) : {};
  const comparison = annotatedTag ? api(`compare/${sha}...main`) : {};
  const jobs = resumeJobRecords(
    parseJson(
      runGh([
        "run",
        "view",
        runId,
        "--repo",
        repo,
        "--attempt",
        String(publisher.runAttempt),
        "--json",
        "jobs",
        "--jq",
        ".jobs",
      ]),
      "resume run jobs",
    ),
  );
  if (!jobs.some((job) => job.name === "publish_openclaw_npm" && job.conclusion === "success")) {
    fail(
      "OpenClaw npm resume run lacks a successful npm publish job; preserve the original publication evidence.",
    );
  }

  return {
    runId,
    runAttempt: publisher.runAttempt,
    ...validateOpenClawNpmResumeRun({
      canonicalWorkflowId: isRecord(canonicalWorkflow) ? canonicalWorkflow.id : undefined,
      compareStatus: isRecord(comparison) ? comparison.status : undefined,
      jobs,
      run,
      tag,
      tagRef,
      trustedWorkflowFullRef,
      trustedWorkflowRef,
    }),
  };
}

function parseArgs(argv: string[]) {
  const options = {
    repo: "",
    runId: "",
  };
  let version = "";
  let tarballSha512 = "";
  let provenanceFile = "";
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--repo") {
      options.repo = argv[(index += 1)] ?? "";
    } else if (arg === "--run-id") {
      options.runId = argv[(index += 1)] ?? "";
    } else if (arg === "--version") {
      version = argv[(index += 1)] ?? "";
    } else if (arg === "--tarball-sha512") {
      tarballSha512 = argv[(index += 1)] ?? "";
    } else if (arg === "--provenance-file") {
      provenanceFile = argv[(index += 1)] ?? "";
    } else {
      fail(`Unknown argument: ${arg}`);
    }
  }
  return {
    ...options,
    publication: {
      version,
      tarballSha512,
      document: parseJson(readFileSync(provenanceFile, "utf8"), "npm provenance file"),
    },
  };
}

export async function verifyOpenClawNpmResumeRun(
  options: Parameters<typeof resolveOpenClawNpmResumeRun>[0],
) {
  const result = resolveOpenClawNpmResumeRun(options);
  const { verifyNpmProvenanceAttestation } = await import("./openclaw-npm-postpublish-verify.ts");
  await verifyNpmProvenanceAttestation({
    packageName: "openclaw",
    version: options.publication.version,
    integrity: `sha512-${Buffer.from(options.publication.tarballSha512, "hex").toString("base64")}`,
    attestations: publicationDocumentSchema.parse(options.publication.document).attestations,
    expectedWorkflowRef: result.workflowRef,
    expectedWorkflowSha: result.workflowSha,
  });
  return result;
}

async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const result = await verifyOpenClawNpmResumeRun(parseArgs(argv));
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
