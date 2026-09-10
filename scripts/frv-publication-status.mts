import { isDeepStrictEqual } from "node:util";
import { z } from "zod";

// Observation limits are independent of the continuation controller's wait budget.
export const PUBLICATION_LIMITS = Object.freeze({
  deadlineMs: 180_000,
  requestMs: 20_000,
  requests: 256,
  runs: 32,
  attempts: 8,
  pages: 10,
  pageSize: 100,
  jsonBytes: 2 * 1024 * 1024,
  archiveBytes: 2 * 1024 * 1024,
  expandedBytes: 1024 * 1024,
  diagnosticBytes: 128 * 1024,
  totalBytes: 32 * 1024 * 1024,
  outputBytes: 256 * 1024,
});
export const FRV_WORKFLOW = ".github/workflows/full-release-validation.yml";
export const PUBLICATION_WORKFLOW = ".github/workflows/openclaw-release-publish.yml";
export const PUBLICATION_DIAGNOSTIC = "release-postpublish-diagnostics.json";

const failureCodes = [
  "usage",
  "identity-mismatch",
  "malformed-evidence",
  "incomplete",
  "transport",
  "deadline",
  "limits",
  "attempt-changed",
] as const;
type FailureCode = (typeof failureCodes)[number];

export class PublicationStatusError extends Error {
  readonly code: FailureCode;
  readonly runId?: string;
  constructor(code: FailureCode, runId?: string) {
    super(`publication observation: ${code}`);
    this.code = code;
    this.runId = runId;
  }
}

export function requirePublication(
  condition: unknown,
  code: FailureCode = "identity-mismatch",
): asserts condition {
  if (!condition) {
    throw new PublicationStatusError(code);
  }
}

export function publicationFailure(error: unknown): FailureCode {
  return error instanceof PublicationStatusError ? error.code : "malformed-evidence";
}

const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
// Passive diagnostic identifiers stay strings; dereferenced IDs are bounded at the reader.
const decimal = z
  .string()
  .max(20)
  .regex(/^[1-9][0-9]*$/u);
const sha = z.string().regex(/^[a-f0-9]{40}$/u);
const ref = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u);
const repository = z
  .string()
  .max(200)
  .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u);
const runState = z.enum(["queued", "in_progress", "completed", "waiting", "pending", "requested"]);
const conclusion = z.enum([
  "success",
  "failure",
  "cancelled",
  "skipped",
  "timed_out",
  "action_required",
  "neutral",
  "stale",
  "startup_failure",
]);
const diagnosticState = z.enum([
  "unattempted",
  "skipped",
  "started",
  "success",
  "failure",
  "unknown",
]);
const diagnosticConclusion = z.enum([...conclusion.options, "unknown"]);
const actor = z.object({
  login: z
    .string()
    .max(100)
    .regex(/^[A-Za-z0-9_.[\]-]+$/u),
});
const runSchema = z.object({
  id,
  run_attempt: id,
  workflow_id: id,
  repository: z.object({ full_name: repository }),
  head_repository: z.object({ full_name: repository }).optional(),
  head_sha: sha,
  head_branch: ref,
  path: z.string().max(500),
  display_title: z.string().max(500).optional(),
  event: z.literal("workflow_dispatch"),
  status: runState,
  conclusion: conclusion.nullable(),
  actor: actor.optional(),
  triggering_actor: actor.optional(),
});
export type PublicationRun = z.infer<typeof runSchema>;

export function parsePublicationRun(value: unknown, repo: string, runId: string): PublicationRun {
  const parsed = runSchema.safeParse(value);
  requirePublication(parsed.success);
  const run = parsed.data;
  requirePublication(
    String(run.id) === runId &&
      run.repository.full_name === repo &&
      (!run.head_repository || run.head_repository.full_name === repo),
  );
  requirePublication(
    /^\.github\/workflows\/[A-Za-z0-9._-]+\.ya?ml(?:@[A-Za-z0-9._/-]+)?$/u.test(run.path),
  );
  const [path, suffix] = run.path.split("@");
  requirePublication(
    path &&
      (!suffix ||
        [run.head_branch, `refs/heads/${run.head_branch}`, `refs/tags/${run.head_branch}`].includes(
          suffix,
        )),
  );
  return run;
}

export function bindPublicationWorkflow(
  run: PublicationRun,
  workflow: unknown,
  expectedPath: string,
) {
  const parsed = z.object({ id, path: z.string() }).safeParse(workflow);
  requirePublication(
    parsed.success &&
      parsed.data.id === run.workflow_id &&
      parsed.data.path === expectedPath &&
      run.path.split("@")[0] === expectedPath,
  );
}

export function assertPublicationRunUnchanged(before: PublicationRun, after: PublicationRun) {
  requirePublication(before.run_attempt === after.run_attempt, "attempt-changed");
  const identity = (run: PublicationRun) => [
    run.id,
    run.workflow_id,
    run.repository.full_name,
    run.head_repository?.full_name ?? null,
    run.head_sha,
    run.head_branch,
    run.path.split("@")[0],
    run.event,
  ];
  // Lifecycle, display and actor-login observations can change without a new identity.
  requirePublication(isDeepStrictEqual(identity(before), identity(after)));
}

const jobSchema = z.object({
  id,
  run_id: id,
  run_attempt: id,
  name: z.string().min(1).max(500),
  status: runState,
  conclusion: conclusion.nullable(),
  started_at: z.string().max(100).nullable().optional(),
  completed_at: z.string().max(100).nullable().optional(),
  html_url: z.string().max(1000).optional(),
  steps: z
    .array(
      z.object({
        number: id,
        name: z.string().max(500),
        status: runState,
        conclusion: conclusion.nullable(),
      }),
    )
    .max(100)
    .optional(),
});
export type PublicationJob = z.infer<typeof jobSchema>;
export function parsePublicationJobs(values: unknown[], runId: string, attempt: number) {
  return values.map((value) => {
    const parsed = jobSchema.safeParse(value);
    requirePublication(parsed.success, "malformed-evidence");
    requirePublication(String(parsed.data.run_id) === runId && parsed.data.run_attempt === attempt);
    return parsed.data;
  });
}

const errorSchema = z.object({
  class: z.enum([
    "registry-not-visible",
    "selector-mismatch",
    "identity-mismatch",
    "transport",
    "malformed-response",
    "command-failure",
    "evidence-write-failure",
  ]),
  status: z.number().int().min(0).max(255).nullable(),
});
const packageSchema = z.object({
  name: z
    .string()
    .max(128)
    .regex(/^@openclaw\/[a-z0-9][a-z0-9._-]*$/u),
  state: diagnosticState,
  publication: z.enum(["unknown", "observed"]),
  error: errorSchema.nullable(),
});
const stageSchema = z.object({
  state: diagnosticState,
  publication: z.enum(["unknown", "observed"]),
  error: errorSchema.nullable(),
  packages: z.array(packageSchema).max(256),
  packagesTruncated: z.boolean(),
});
const stageNames = [
  "checkout",
  "githubRelease",
  "coreNpm",
  "postpublish",
  "pluginNpm",
  "clawHub",
  "fullReleaseValidation",
  "pluginNpmRun",
  "pluginClawHubRun",
  "pluginClawHubBootstrap",
  "openclawNpm",
  "npmTelegram",
  "evidence",
  "binding",
  "assets",
] as const;
export const PUBLICATION_CHILDREN = {
  openclawNpm: { workflow: ".github/workflows/openclaw-npm-release.yml", surface: "coreNpm" },
  pluginNpm: { workflow: ".github/workflows/plugin-npm-release.yml", surface: "pluginNpm" },
  pluginClawHub: { workflow: ".github/workflows/plugin-clawhub-release.yml", surface: "clawHub" },
  pluginClawHubBootstrap: {
    workflow: ".github/workflows/plugin-clawhub-new.yml",
    surface: "clawHub",
  },
  npmTelegram: { workflow: ".github/workflows/npm-telegram-beta-e2e.yml", surface: "npmTelegram" },
} as const;
const childNames = ["fullReleaseValidation", ...Object.keys(PUBLICATION_CHILDREN)] as [
  string,
  ...string[],
];
const diagnosticSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("release-postpublish-diagnostics"),
  invocationId: z.string().uuid(),
  context: z.object({
    repository: repository.nullable(),
    releaseVersion: z
      .string()
      .max(80)
      .regex(/^[0-9]+(?:\.[0-9]+){2}(?:-[a-z0-9.-]+)?$/u)
      .nullable(),
    releaseTag: z
      .string()
      .max(81)
      .regex(/^v[0-9]+(?:\.[0-9]+){2}(?:-[a-z0-9.-]+)?$/u)
      .nullable(),
    npmDistTag: z.enum(["latest", "beta", "alpha", "extended-stable"]).nullable(),
    requestedSourceSha: sha.nullable(),
    toolingSha: sha.nullable(),
    suppliedToolingSha: sha.nullable(),
    suppliedToolingRef: ref.nullable(),
    parentRunId: decimal.nullable(),
    parentRunAttempt: decimal.nullable(),
    validationEvidence: z.object({
      mode: z.enum(["full-release-validation", "authorized-beta-focused-v1"]).nullable(),
      runId: decimal.nullable(),
      runAttempt: decimal.nullable(),
    }),
  }),
  selection: z.object({
    plugins: z.array(packageSchema.shape.name).max(256),
    pluginsTruncated: z.boolean(),
    workflowRef: ref.nullable(),
    clawHubWorkflowRef: ref.nullable(),
  }),
  verification: diagnosticState,
  currentStage: z.enum(stageNames).nullable(),
  stages: z.record(z.enum(stageNames), stageSchema),
  children: z.record(
    z.enum(childNames),
    z.object({
      suppliedRunId: decimal.nullable(),
      runAttempt: decimal.nullable(),
      producerRunAttempt: decimal.nullable(),
      status: z.enum([...runState.options, "unknown"]),
      conclusion: diagnosticConclusion,
      failedJobCount: z.number().int().min(0).max(10000).nullable(),
      readbackArtifactId: decimal.nullable(),
      packageArtifactId: decimal.nullable(),
    }),
  ),
  jobOutcomeBeforeArtifactUploads: diagnosticConclusion,
  stepOutcomes: z.object({ coreStart: diagnosticConclusion, completion: diagnosticConclusion }),
});
export type PublicationDiagnostic = z.infer<typeof diagnosticSchema>;

export function parsePublicationDiagnostic(
  value: unknown,
  run: PublicationRun,
): PublicationDiagnostic | null {
  const envelope = z.object({ kind: z.string(), schemaVersion: z.number() }).safeParse(value);
  requirePublication(envelope.success, "malformed-evidence");
  if (
    envelope.data.kind !== "release-postpublish-diagnostics" ||
    envelope.data.schemaVersion !== 1
  ) {
    return null;
  }
  const parsed = diagnosticSchema.safeParse(value);
  requirePublication(parsed.success, "malformed-evidence");
  const diagnostic = parsed.data;
  const context = diagnostic.context;
  if (
    [
      context.repository,
      context.parentRunId,
      context.parentRunAttempt,
      context.toolingSha,
      context.suppliedToolingSha,
      context.suppliedToolingRef,
    ].includes(null)
  ) {
    return null;
  }
  // The record supplies linkage, not its own producer authority.
  requirePublication(
    context.repository === run.repository.full_name &&
      context.parentRunId === String(run.id) &&
      context.parentRunAttempt === String(run.run_attempt) &&
      context.toolingSha === run.head_sha &&
      context.suppliedToolingSha === run.head_sha,
  );
  requirePublication(
    context.suppliedToolingRef === `refs/heads/${run.head_branch}` ||
      context.suppliedToolingRef === `refs/tags/${run.head_branch}`,
  );
  const suffix = run.path.split("@")[1];
  requirePublication(
    !suffix || suffix === run.head_branch || suffix === context.suppliedToolingRef,
  );
  const protectedRef = /^release-publish\/([a-f0-9]{12})-[1-9][0-9]*$/u.exec(run.head_branch);
  requirePublication(!protectedRef || protectedRef[1] === run.head_sha.slice(0, 12));
  return diagnostic;
}

type EvidenceRef = {
  kind: "owner-diagnostic" | "job-conclusion" | "dispatch-record" | "terminal-marker";
  runId: string;
  runAttempt: number;
  artifactId?: number;
  jobId?: number;
};
type Phase = { state: string; evidence: EvidenceRef[] };
type Surface = {
  selection: "unknown" | "selected" | "not-selected";
  verificationSelection: "unknown" | "selected" | "not-selected";
  operation: Phase;
  verification: Phase;
  registryObservation: Phase;
  terminalMarker: Phase;
  verificationError: z.infer<typeof errorSchema> | null;
  packages: z.infer<typeof packageSchema>[];
  packagesOmitted?: number;
  advisory: boolean;
  jobsOmitted?: number;
  jobs: {
    jobId: number;
    runId: string;
    runAttempt: number;
    status: string;
    conclusion: string | null;
    steps: {
      phase: "copy" | "smoke" | "aliases";
      number: number;
      status: string;
      conclusion: string | null;
    }[];
  }[];
  children: {
    runId: string;
    workflowSha: string;
    workflowRef: string;
    recordedAttempt: number | null;
    observedAttempt: number;
    status: string;
    conclusion: string | null;
    relation: "supplied" | "dispatch-record";
  }[];
};
const surfaces = [
  "coreNpm",
  "pluginNpm",
  "clawHub",
  "docker",
  "activation",
  "vcr",
  "nativeWindows",
  "nativeAndroid",
  "nativeMac",
  "npmTelegram",
] as const;
type SurfaceName = (typeof surfaces)[number];
export type PublicationObservation = {
  version: 1;
  requested: { repository: string; validationRunId: string; publicationRunId: string };
  publisher: {
    runId: string;
    runAttempt: number;
    workflowSha: string;
    status: string;
    conclusion: string | null;
  } | null;
  relationship: {
    status: "unverified" | "verified" | "invalid";
    reason: string;
    originalPlanAttempt: number | null;
    validationAttempt: number | null;
    candidateSha: string | null;
    validationToolingSha: string | null;
  };
  collection: {
    complete: boolean;
    error: FailureCode | null;
    outputTruncated?: true;
    validationStatusOmitted?: boolean;
  };
  diagnostics: {
    state: "missing" | "expired" | "unsupported" | "available" | "legacy-only";
    artifactId: number | null;
    truncated: boolean;
  };
  verification: Phase;
  binding: Phase;
  assets: Phase;
  dispatches: {
    scope: "normal-clawhub" | "windows";
    state: "acknowledged" | "not-dispatched" | "unknown";
    runId: string;
    runAttempt: number;
    artifactId: number;
  }[];
  surfaces: Record<SurfaceName, Surface>;
};

export function newPublicationObservation(
  repo: string,
  validationRunId: string,
  publicationRunId: string,
): PublicationObservation {
  const phase = (): Phase => ({ state: "unknown", evidence: [] });
  return {
    version: 1,
    requested: { repository: repo, validationRunId, publicationRunId },
    publisher: null,
    relationship: {
      status: "unverified",
      reason: "no-supported-link",
      originalPlanAttempt: null,
      validationAttempt: null,
      candidateSha: null,
      validationToolingSha: null,
    },
    collection: { complete: false, error: null },
    diagnostics: { state: "missing", artifactId: null, truncated: false },
    verification: phase(),
    binding: phase(),
    assets: phase(),
    dispatches: [],
    surfaces: Object.fromEntries(
      surfaces.map((name): [SurfaceName, Surface] => [
        name,
        {
          selection: "unknown",
          verificationSelection: "unknown",
          operation: phase(),
          verification: phase(),
          registryObservation: phase(),
          terminalMarker: phase(),
          advisory: ["vcr", "nativeWindows", "nativeAndroid", "nativeMac", "npmTelegram"].includes(
            name,
          ),
          jobs: [],
          children: [],
          verificationError: null,
          packages: [],
        },
      ]),
    ) as Record<SurfaceName, Surface>,
  };
}

export function compactPublicationObservation(
  observation: PublicationObservation,
  validationStatusOmitted: boolean,
): PublicationObservation {
  const retainedItems = 4;
  return {
    ...observation,
    collection: {
      ...observation.collection,
      complete: false,
      error: observation.collection.error ?? "limits",
      outputTruncated: true,
      validationStatusOmitted,
    },
    surfaces: Object.fromEntries(
      surfaces.map((name): [SurfaceName, Surface] => {
        const surface = observation.surfaces[name];
        const jobs = surface.jobs.slice(0, retainedItems);
        const packages = surface.packages.slice(0, retainedItems);
        const jobsOmitted = (surface.jobsOmitted ?? 0) + surface.jobs.length - jobs.length;
        const packagesOmitted =
          (surface.packagesOmitted ?? 0) + surface.packages.length - packages.length;
        return [
          name,
          {
            ...surface,
            jobs,
            packages,
            ...(jobsOmitted ? { jobsOmitted } : {}),
            ...(packagesOmitted ? { packagesOmitted } : {}),
          },
        ];
      }),
    ) as Record<SurfaceName, Surface>,
  };
}

export function observePublicationJobs(
  observation: PublicationObservation,
  run: PublicationRun,
  jobs: PublicationJob[],
) {
  const mapping: [SurfaceName, string, boolean][] = [
    ["coreNpm", "Publish plugins, then OpenClaw", false],
    ["pluginNpm", "Publish plugins, then OpenClaw", false],
    ["clawHub", "Publish plugins, then OpenClaw", false],
    ["coreNpm", "Verify already-published core npm package", false],
    ["docker", "Publish Docker images / ", true],
    ["vcr", "Mirror Docker images to Vercel Container Registry / ", true],
    ["activation", "Finalize GitHub release", false],
    ["nativeWindows", "Dispatch Windows assets after publication", false],
    ["nativeAndroid", "Approve and dispatch qualified Android", false],
  ];
  for (const [surface, name, prefix] of mapping) {
    for (const job of jobs.filter((entry) =>
      prefix ? entry.name.startsWith(name) : entry.name === name,
    )) {
      observation.surfaces[surface].jobs.push({
        jobId: job.id,
        runId: String(run.id),
        runAttempt: run.run_attempt,
        status: job.status,
        conclusion: job.conclusion,
        steps:
          surface === "vcr"
            ? (job.steps ?? []).flatMap((step) => {
                const phase = {
                  "Copy and verify immutable release images": "copy",
                  "Run custom-image Sandbox smoke": "smoke",
                  "Promote and verify channel aliases": "aliases",
                }[step.name] as "copy" | "smoke" | "aliases" | undefined;
                return phase
                  ? [
                      {
                        phase,
                        number: step.number,
                        status: step.status,
                        conclusion: step.conclusion,
                      },
                    ]
                  : [];
              })
            : [],
      });
    }
  }
  // Job conclusions are observations of jobs, not receipts for their privileged operations.
}

export function observePublicationDiagnostic(
  observation: PublicationObservation,
  diagnostic: PublicationDiagnostic,
  artifactId: number,
) {
  requirePublication(observation.publisher);
  const evidence: EvidenceRef[] = [
    {
      kind: "owner-diagnostic",
      artifactId,
      runId: observation.publisher.runId,
      runAttempt: observation.publisher.runAttempt,
    },
  ];
  observation.diagnostics = {
    state: "available",
    artifactId,
    truncated:
      diagnostic.selection.pluginsTruncated ||
      Object.values(diagnostic.stages).some((stage) => stage.packagesTruncated),
  };
  observation.verification = { state: diagnostic.verification, evidence };
  observation.binding = { state: diagnostic.stages.binding.state, evidence };
  observation.assets = { state: diagnostic.stages.assets.state, evidence };
  for (const name of ["coreNpm", "pluginNpm", "clawHub", "npmTelegram"] as const) {
    const stage = diagnostic.stages[name];
    const surface = observation.surfaces[name];
    surface.verification = { state: stage.state, evidence };
    surface.registryObservation = { state: stage.publication, evidence };
    surface.verificationError = stage.error;
    surface.packages = stage.packages;
    surface.verificationSelection =
      stage.state === "skipped"
        ? "not-selected"
        : stage.state === "unattempted"
          ? "unknown"
          : "selected";
  }
}

export function joinPublicationValidation(
  observation: PublicationObservation,
  diagnostic: PublicationDiagnostic,
  plan: Record<string, unknown>,
  manifest: Record<string, unknown>,
  rawManifest: Record<string, unknown>,
) {
  const context = diagnostic.context;
  requirePublication(
    context.validationEvidence.runId === observation.requested.validationRunId &&
      context.requestedSourceSha === plan.targetSha &&
      manifest.targetSha === plan.targetSha &&
      manifest.workflowSha === plan.workflowSha &&
      manifest.workflowRef === plan.workflowRef &&
      manifest.releaseProfile === plan.releaseProfile &&
      manifest.rerunGroup === plan.rerunGroup &&
      rawManifest.executionPlanSha256 === plan.sha256 &&
      Number(rawManifest.sourceParentRunAttempt) === plan.parentRunAttempt &&
      isDeepStrictEqual(manifest.candidateBinding, plan.candidate) &&
      Number(context.validationEvidence.runAttempt) === manifest.runAttempt &&
      plan.parentRunAttempt <= manifest.runAttempt,
  );
  observation.relationship = {
    status: "verified",
    reason: "attempt-bound-diagnostic",
    originalPlanAttempt: plan.parentRunAttempt,
    validationAttempt: manifest.runAttempt,
    candidateSha: String(plan.targetSha),
    validationToolingSha: String(plan.workflowSha),
  };
}

export function boundPublicationManifest(value: unknown) {
  const parsed = z
    .object({
      childEvidence: z
        .record(
          z.string(),
          z.object({
            plannedRunAttempt: id,
            effectiveRunAttempt: id,
            observedRunAttempts: z.array(id).max(PUBLICATION_LIMITS.attempts),
            jobs: z.array(z.unknown()).max(PUBLICATION_LIMITS.pages * PUBLICATION_LIMITS.pageSize),
          }),
        )
        .optional(),
    })
    .safeParse(value);
  requirePublication(parsed.success, "limits");
  const children = Object.values(parsed.data.childEvidence ?? {});
  requirePublication(children.length <= PUBLICATION_LIMITS.runs, "limits");
  for (const child of children) {
    requirePublication(
      child.effectiveRunAttempt >= child.plannedRunAttempt &&
        child.effectiveRunAttempt - child.plannedRunAttempt < PUBLICATION_LIMITS.attempts,
      "limits",
    );
  }
}

export function parseClawHubDispatch(value: unknown, run: PublicationRun, candidateSha: string) {
  const parsed = z
    .object({
      schemaVersion: z.literal(1),
      repository,
      parentRunId: decimal,
      parentRunAttempt: decimal,
      parentWorkflow: z.literal(PUBLICATION_WORKFLOW),
      toolingRef: ref,
      toolingFullRef: ref,
      toolingSha: sha,
      candidateSha: sha,
      normalClawHubRunId: decimal.nullable(),
      normalClawHubRunAttempt: decimal.nullable(),
    })
    .safeParse(value);
  requirePublication(parsed.success, "malformed-evidence");
  const record = parsed.data;
  requirePublication(
    record.repository === run.repository.full_name &&
      record.parentRunId === String(run.id) &&
      record.parentRunAttempt === String(run.run_attempt) &&
      record.toolingSha === run.head_sha &&
      record.toolingRef === run.head_branch &&
      record.candidateSha === candidateSha &&
      [record.toolingRef, record.toolingFullRef].includes(
        run.path.split("@")[1] ?? record.toolingRef,
      ) &&
      (record.toolingFullRef === `refs/heads/${run.head_branch}` ||
        record.toolingFullRef === `refs/tags/${run.head_branch}`) &&
      (record.normalClawHubRunId === null) === (record.normalClawHubRunAttempt === null),
  );
  return record;
}

export function observePublicationChild(
  observation: PublicationObservation,
  surface: SurfaceName,
  run: PublicationRun,
  recordedAttempt: number | null,
  relation: "supplied" | "dispatch-record" = "supplied",
) {
  observation.surfaces[surface].children.push({
    runId: String(run.id),
    workflowSha: run.head_sha,
    workflowRef: run.head_branch,
    recordedAttempt,
    observedAttempt: run.run_attempt,
    status: run.status,
    conclusion: run.conclusion,
    relation,
  });
}

export function parseWindowsDispatch(value: unknown) {
  const parsed = z
    .object({
      tag: z
        .string()
        .max(81)
        .regex(/^v[0-9]+(?:\.[0-9]+){2}(?:-[a-z0-9.-]+)?$/u),
      sourceTag: ref,
      installerDigests: z.string().max(4096),
      state: z.enum(["dispatched", "dispatch-failed"]),
      childRunId: decimal.optional(),
    })
    .safeParse(value);
  requirePublication(parsed.success, "malformed-evidence");
  requirePublication(parsed.data.state !== "dispatched" || parsed.data.childRunId);
  return parsed.data;
}

export function observeWindowsMarker(
  observation: PublicationObservation,
  value: unknown,
  dispatch: ReturnType<typeof parseWindowsDispatch>,
  run: PublicationRun,
  artifactId: number,
  job: PublicationJob,
) {
  const parsed = z
    .object({
      schemaVersion: z.literal(1),
      tag: z.string(),
      sourceTag: z.string(),
      installerDigests: z.string(),
      outcome: diagnosticConclusion,
      runUrl: z.string(),
    })
    .safeParse(value);
  requirePublication(parsed.success, "malformed-evidence");
  requirePublication(
    parsed.data.tag === dispatch.tag &&
      parsed.data.sourceTag === dispatch.sourceTag &&
      parsed.data.installerDigests === dispatch.installerDigests &&
      parsed.data.runUrl ===
        `https://github.com/${run.repository.full_name}/actions/runs/${run.id}`,
  );
  observation.surfaces.nativeWindows.terminalMarker = {
    state: parsed.data.outcome,
    evidence: [
      { kind: "terminal-marker", runId: String(run.id), runAttempt: run.run_attempt, artifactId },
    ],
  };
  observation.surfaces.nativeWindows.jobs.push({
    jobId: job.id,
    runId: String(run.id),
    runAttempt: run.run_attempt,
    status: job.status,
    conclusion: job.conclusion,
    steps: [],
  });
}

export function formatPublicationObservation(value: PublicationObservation) {
  const lines = [
    "Publication observation (not release authorization)",
    `relationship: ${value.relationship.status} (${value.relationship.reason})`,
    `collection: ${value.collection.complete ? "complete" : `incomplete (${value.collection.error ?? "unknown"})`}`,
    `publisher: ${value.publisher?.runId ?? "unknown"} attempt=${value.publisher?.runAttempt ?? "unknown"} ${value.publisher?.status ?? "unknown"}/${value.publisher?.conclusion ?? "unknown"}`,
    `validation binding: original-plan-attempt=${value.relationship.originalPlanAttempt ?? "unknown"} selected-attempt=${value.relationship.validationAttempt ?? "unknown"}`,
    `diagnostics: ${value.diagnostics.state}; verification=${value.verification.state}; binding=${value.binding.state}; assets=${value.assets.state}`,
  ];
  if (value.collection.validationStatusOmitted) {
    lines.push("validation detail omitted: output limit");
  }
  for (const name of surfaces) {
    const surface = value.surfaces[name];
    lines.push(
      `${name}: selection=${surface.selection} operation=${surface.operation.state} verification=${surface.verification.state} registry-observation=${surface.registryObservation.state} terminal-marker=${surface.terminalMarker.state}${surface.advisory ? " advisory" : ""}`,
    );
    for (const job of surface.jobs) {
      lines.push(
        `  job=${job.jobId} run=${job.runId} attempt=${job.runAttempt} ${job.status}/${job.conclusion ?? "unknown"} (job conclusion only)`,
      );
      for (const step of job.steps) {
        lines.push(
          `    ${step.phase}: ${step.status}/${step.conclusion ?? "unknown"} (API step conclusion only)`,
        );
      }
    }
    if (surface.jobsOmitted) {
      lines.push(`  jobs omitted: ${surface.jobsOmitted} (output limit)`);
    }
    for (const item of surface.packages) {
      lines.push(
        `  ${item.name}: verification=${item.state} registry-observation=${item.publication} error=${item.error?.class ?? "none"}`,
      );
    }
    if (surface.packagesOmitted) {
      lines.push(`  packages omitted: ${surface.packagesOmitted} (output limit)`);
    }
    for (const child of surface.children) {
      lines.push(
        `  child=${child.runId} recorded-attempt=${child.recordedAttempt ?? "unknown"} observed-attempt=${child.observedAttempt} ${child.status}/${child.conclusion ?? "unknown"} (${child.relation}) workflow-ref=${child.workflowRef} workflow-sha=${child.workflowSha}`,
      );
    }
  }
  for (const dispatch of value.dispatches) {
    lines.push(
      `${dispatch.scope} dispatch: ${dispatch.state} parent=${dispatch.runId} attempt=${dispatch.runAttempt} artifact=${dispatch.artifactId}`,
    );
  }
  lines.push(
    "Missing observations remain unknown; consult the existing owner evidence. No recovery action was performed.",
  );
  return lines.join("\n");
}
