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

const packetSchema = z.strictObject({
  request: z.unknown(),
  digest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
});
// Evidence manifests exceed the 128 KiB source-admission input cap; digest their canonical JSON uncapped.
export function releaseFastTrackDigest(value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(canonicalizeJsonValue(value)))
    .digest("hex")}`;
}
export function parseFastTrackPacket(value: unknown) {
  const packet = packetSchema.parse(typeof value === "string" ? JSON.parse(value) : value);
  const request = parseFastTrackRequest(packet.request);
  if (packet.digest !== fastTrackRequestDigest(request)) {
    throw new Error("Fast-track request digest mismatch.");
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

/** Binds exception evidence. Publication authority comes only from the npm-release receipt. */
export type FastTrackManifest = {
  targetSha: string;
  runId: string;
  runAttempt: number | string;
  sourceAdmission?: PublicationSourceFact;
  publicationArtifacts?: { npmPreflight?: unknown; [key: string]: unknown };
  publicationAdmission?: unknown;
};
export function bindFastTrackPacket(value: unknown, inputManifest: unknown, now = Date.now()) {
  const packet = parseFastTrackPacket(value);
  const { request } = packet;
  if (Date.parse(request.expiresAt) <= now) {
    throw new Error(
      "Fast-track request expired. Prepare a fresh request for npm-release approval.",
    );
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
      "Fast-track request does not bind the publication candidate, channel or original FRV attempt.",
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
      "Fast-track artifact digests or publication scope differ from the selected request.",
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
  readPublishedRelease: (tag: string) => {
    draft?: boolean;
    published_at?: string;
    targetSha?: string;
    fastTracked?: boolean;
  };
}) {
  const packet = bindFastTrackPacket(
    input.packet,
    input.manifest,
    await fastTrackAdmissionTime(input.packet, input.publication),
  );
  const { request } = packet;
  if (request.policy === "approved-fast-track-v1") {
    // The request schema omits reference/delta only for beta prereleases, which have
    // no delta ceiling. Everything else is measured against a shipped baseline.
    if (request.reference) {
      // A shipped, non-fast-tracked release already passed its own publication gates.
      // Do not replay its historical validation evidence under current tooling.
      const release = input.readPublishedRelease(request.reference.releaseTag);
      if (
        release.draft !== false ||
        !release.published_at ||
        release.targetSha !== request.reference.targetSha ||
        release.fastTracked
      ) {
        throw new Error(
          "Fast-track baseline must be a published release that was not itself fast-tracked.",
        );
      }
      collectFastTrackEligibility({
        repositoryRoot: input.repositoryRoot,
        request,
        validatedReference: {
          repository: request.repository,
          ...request.reference,
          published: true,
        },
      });
    }
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
        "Partial-FRV request does not match original evidence and all outstanding jobs. Prepare a fresh snapshot.",
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
  const packet = parseFastTrackPacket(value);
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
    throw new Error(
      "Fast-track request expired. Prepare a fresh request for npm-release approval.",
    );
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
      fastTrackRequest: packet,
      parentStatePolicy: run.status === "completed" ? "manual-recovery" : "active",
    },
    token: process.env.GH_TOKEN,
  });
  const admittedAt = Date.parse(result.approvedAt ?? "");
  if (!Number.isFinite(admittedAt) || admittedAt >= Date.parse(packet.request.expiresAt)) {
    throw new Error("Original publisher did not admit this exact request before expiry.");
  }
  return admittedAt;
}
