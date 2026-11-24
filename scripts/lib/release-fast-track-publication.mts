import { createHash } from "node:crypto";
import { z } from "zod";
import {
  publicationSourceJson,
  type PublicationSourceFact,
} from "../full-release-publication-contract.mjs";
import { canonicalizeJsonValue } from "./canonical-json.mjs";
import {
  collectFastTrackEligibility,
  fastTrackRequestDigest,
  parseFastTrackRequest,
} from "./release-fast-track-contract.mts";

const runId = z.string().regex(/^[1-9][0-9]*$/u);
const packetSchema = z.strictObject({
  request: z.unknown(),
  digest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  approval: z.strictObject({
    approver: z.string().min(1).max(200),
    decidedAt: z.string().datetime(),
    url: z.url().refine((value) => new URL(value).protocol === "https:"),
  }),
  referenceRunId: runId.optional(),
  referenceRunAttempt: runId.optional(),
});
// Evidence manifests exceed the 128 KiB source-admission input cap; digest their canonical JSON uncapped.
export function releaseFastTrackDigest(value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(canonicalizeJsonValue(value)))
    .digest("hex")}`;
}
export function parseFastTrackApproval(value: unknown) {
  const packet = packetSchema.parse(typeof value === "string" ? JSON.parse(value) : value);
  const request = parseFastTrackRequest(packet.request);
  if (packet.digest !== fastTrackRequestDigest(request)) {
    throw new Error("Fast-track approval request digest mismatch.");
  }
  if (
    Date.parse(packet.approval.decidedAt) >= Date.parse(request.expiresAt) ||
    Date.parse(packet.approval.decidedAt) > Date.now()
  ) {
    throw new Error("Fast-track approval must precede expiry and cannot be in the future.");
  }
  return { ...packet, request };
}

const manifestBindingSchema = z
  .object({
    targetSha: z.string(),
    runId: z.union([z.string(), z.number()]),
    runAttempt: z.union([z.string(), z.number()]),
    sourceAdmission: z
      .object({
        repository: z.string(),
        projection: z.object({ version: z.string() }),
        publicationSelection: z.object({ npmDistTag: z.string() }).passthrough(),
      })
      .passthrough(),
    publicationArtifacts: z.object({ npmPreflight: z.unknown() }).passthrough(),
    publicationAdmission: z.unknown(),
  })
  .passthrough();

/** Checks the reviewed operands, not whether a human actually wrote the decision. Skills own that procedural boundary. */
export type FastTrackManifest = {
  targetSha: string;
  runId: string;
  runAttempt: number | string;
  sourceAdmission?: PublicationSourceFact;
  publicationArtifacts?: { npmPreflight?: unknown; [key: string]: unknown };
  publicationAdmission?: unknown;
};
export type FastTrackReference = {
  current: { targetSha: string; manifest: FastTrackManifest };
  fastTrack?: unknown;
};
export function bindFastTrackApproval(value: unknown, inputManifest: unknown, now = Date.now()) {
  const packet = parseFastTrackApproval(value);
  const { request } = packet;
  if (Date.parse(request.expiresAt) <= now) {
    throw new Error("Fast-track request expired. Obtain fresh explicit approval.");
  }
  const manifest = manifestBindingSchema.parse(inputManifest);
  const source = manifest.sourceAdmission;
  if (
    request.repository !== source?.repository ||
    request.candidateSha !== manifest.targetSha ||
    request.releaseTag !== `v${source?.projection?.version}` ||
    request.channel !== source?.publicationSelection?.npmDistTag ||
    request.run.id !== String(manifest.runId) ||
    request.run.attempt !== String(manifest.runAttempt)
  ) {
    throw new Error(
      "Fast-track approval does not bind the publication candidate, channel or original FRV attempt.",
    );
  }
  const artifacts = [
    {
      name: "publication-artifacts",
      digest: releaseFastTrackDigest(manifest.publicationArtifacts),
    },
  ];
  const scope = [`publication:${releaseFastTrackDigest(source.publicationSelection)}`];
  if (
    publicationSourceJson(request.artifacts) !== publicationSourceJson(artifacts) ||
    publicationSourceJson(request.publicationScope) !== publicationSourceJson(scope)
  ) {
    throw new Error(
      "Fast-track artifact digests or publication scope differ from the approved request.",
    );
  }
  if (!manifest.publicationArtifacts?.npmPreflight || !manifest.publicationAdmission) {
    throw new Error(
      "Fast-track requires sealed publication artifacts and original publication admission.",
    );
  }
  return packet;
}

export type FastTrackJob = {
  name: string;
  jobId: string;
  runId: string;
  runAttempt: string;
  status: "passed" | "failed" | "cancelled" | "skipped" | "unfinished";
};
export function fastTrackValidationSnapshot(manifest: unknown, jobs: FastTrackJob[]) {
  const summary = { passed: 0, failed: 0, cancelled: 0, skipped: 0, unfinished: 0 };
  for (const job of jobs) {
    summary[job.status]++;
  }
  return {
    evidenceDigest: releaseFastTrackDigest(manifest),
    summary,
    outstandingChecks: jobs
      .filter((job) => job.status !== "passed")
      .toSorted((a, b) => a.jobId.localeCompare(b.jobId)),
  };
}

export type FastTrackPublication = { runId: string | number; runAttempt: string | number };

export async function authenticateFastTrackPolicy(input: {
  publication?: FastTrackPublication;
  packet: unknown;
  manifest: FastTrackManifest;
  jobs: FastTrackJob[];
  repositoryRoot: string;
  loadReference: (runId: string, attempt: string) => Promise<FastTrackReference>;
  readPublishedRelease: (tag: string) => {
    draft?: boolean;
    published_at?: string;
    targetSha?: string;
    fastTracked?: boolean;
  };
}) {
  const packet = bindFastTrackApproval(
    input.packet,
    input.manifest,
    await fastTrackAdmissionTime(input.packet, input.publication),
  );
  const { request } = packet;
  if (request.policy === "approved-fast-track-v1") {
    if (
      !packet.referenceRunId ||
      !packet.referenceRunAttempt ||
      packet.referenceRunId === request.run.id
    ) {
      throw new Error(
        "Small-delta fast-track requires the original fully validated published reference run and attempt.",
      );
    }
    const reference = await input.loadReference(packet.referenceRunId, packet.referenceRunAttempt);
    const release = input.readPublishedRelease(request.reference.releaseTag);
    if (
      release.draft !== false ||
      !release.published_at ||
      release.targetSha !== request.reference.targetSha ||
      release.fastTracked ||
      reference.current.targetSha !== request.reference.targetSha ||
      reference.current.manifest.sourceAdmission?.projection?.version !==
        request.reference.releaseTag.slice(1) ||
      releaseFastTrackDigest(reference.current.manifest) !==
        request.reference.validationEvidenceDigest ||
      reference.fastTrack
    ) {
      throw new Error(
        "Fast-track baseline must be a published fully validated release with matching original evidence.",
      );
    }
    collectFastTrackEligibility({
      repositoryRoot: input.repositoryRoot,
      request,
      validatedReference: {
        repository: request.repository,
        ...request.reference,
        validationMode: "full-release-validation",
        published: true,
      },
    });
  } else {
    const actual = fastTrackValidationSnapshot(input.manifest, input.jobs);
    const expected = request.validationSnapshot;
    if (
      expected.runId !== request.run.id ||
      expected.runAttempt !== request.run.attempt ||
      expected.evidenceDigest !== actual.evidenceDigest ||
      publicationSourceJson(expected.summary) !== publicationSourceJson(actual.summary) ||
      publicationSourceJson(
        expected.outstandingChecks.toSorted((a, b) => a.jobId.localeCompare(b.jobId)),
      ) !== publicationSourceJson(actual.outstandingChecks)
    ) {
      throw new Error(
        "Partial-FRV approval does not match original evidence and all outstanding jobs. Prepare a fresh snapshot.",
      );
    }
  }
  return {
    ...packet,
    disposition: "validation skipped by approved fast-track" as const,
    snapshot: fastTrackValidationSnapshot(input.manifest, input.jobs),
  };
}

/** Expiry gates new admission, not completion of an already approved exact publication. */
export async function fastTrackAdmissionTime(
  value: unknown,
  publication?: FastTrackPublication,
): Promise<number> {
  const packet = parseFastTrackApproval(value);
  const now = Date.now();
  if (Date.parse(packet.request.expiresAt) > now) {
    return now;
  }
  const parentRunId = publication
    ? String(publication.runId)
    : process.env.RELEASE_PUBLISH_RUN_ID ||
      (process.env.GITHUB_JOB === "publish" ? process.env.GITHUB_RUN_ID : undefined);
  const parentRunAttempt = publication
    ? String(publication.runAttempt)
    : process.env.RELEASE_PUBLISH_RUN_ATTEMPT ||
      (process.env.GITHUB_JOB === "publish" ? process.env.GITHUB_RUN_ATTEMPT : undefined);
  if (
    !parentRunId ||
    !parentRunAttempt ||
    ![parentRunId, parentRunAttempt].every((part) => /^[1-9][0-9]*$/u.test(part))
  ) {
    throw new Error("Fast-track request expired. Obtain fresh explicit approval.");
  }
  const { runReleaseToolingGh } = await import("../release-tooling-identity.mjs");
  const { downloadReleaseApprovalReceipt } = await import("../release-approval-receipt.mjs");
  const run = JSON.parse(
    runReleaseToolingGh([
      "api",
      `repos/${packet.request.repository}/actions/runs/${parentRunId}`,
      "--method",
      "GET",
    ]),
  );
  const fullRef = run.head_branch?.startsWith("release-publish/")
    ? `refs/tags/${run.head_branch}`
    : `refs/heads/${run.head_branch}`;
  const result = await downloadReleaseApprovalReceipt({
    expected: {
      repository: packet.request.repository,
      parentRunId,
      parentRunAttempt,
      toolingRef: run.head_branch,
      toolingFullRef: fullRef,
      toolingSha: run.head_sha,
      releaseTag: packet.request.releaseTag,
      targetSha: packet.request.candidateSha,
      npmDistTag: packet.request.channel,
      fastTrackApproval: packet,
      parentStatePolicy: run.status === "completed" ? "manual-recovery" : "active",
    },
    token: process.env.GH_TOKEN,
  });
  const admittedAt = Date.parse(result.approvedAt ?? "");
  if (
    !Number.isFinite(admittedAt) ||
    admittedAt < Date.parse(packet.approval.decidedAt) ||
    admittedAt >= Date.parse(packet.request.expiresAt)
  ) {
    throw new Error("Original publisher did not admit this exact approval before expiry.");
  }
  return admittedAt;
}
