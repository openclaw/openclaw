import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { z } from "zod";
import { validateNpmPublishBoundary } from "../openclaw-npm-extended-stable-release.mjs";
import { classifyReleaseTrain, parseReleaseVersion } from "./release-version.mjs";

export const FAST_TRACK_POLICY = "approved-fast-track-v1";
export const FAST_TRACK_ACTION = "Approve skipping release validation";
const sha = z.string().regex(/^[a-f0-9]{40}$/u);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const id = z.string().regex(/^[1-9][0-9]{0,19}$/u);
const releaseTag = z
  .string()
  .max(100)
  .refine((value) => {
    const version = value.startsWith("v") ? parseReleaseVersion(value.slice(1)) : null;
    return (
      version !== null &&
      version.channel !== "alpha" &&
      classifyReleaseTrain(version) !== "unsupported-extended-stable-correction"
    );
  }, "Invalid release tag.");
const repository = z
  .string()
  .max(200)
  .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const artifact = z.strictObject({
  name: z
    .string()
    .min(1)
    .max(256)
    .regex(/^[A-Za-z0-9@][A-Za-z0-9@._/+:-]*$/u),
  digest,
});

export const fastTrackRequestSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    policy: z.literal(FAST_TRACK_POLICY),
    action: z.literal(FAST_TRACK_ACTION),
    repository,
    releaseTag,
    channel: z.enum(["beta", "latest", "extended-stable"]),
    candidateSha: sha,
    reference: z.strictObject({ releaseTag, targetSha: sha, validationEvidenceDigest: digest }),
    delta: z.strictObject({ commits: count, added: count, deleted: count }),
    artifacts: z.array(artifact).min(1).max(256),
    publicationScope: z
      .array(
        z
          .string()
          .min(1)
          .max(200)
          .regex(/^[A-Za-z0-9@][A-Za-z0-9@._/+:-]*$/u),
      )
      .min(1)
      .max(256),
    run: z.strictObject({ id, attempt: id }),
    requestId: z
      .string()
      .regex(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u),
    expiresAt: z.string().datetime(),
  })
  .superRefine((request, context) => {
    try {
      validateNpmPublishBoundary(request.releaseTag.slice(1), request.channel);
    } catch {
      context.addIssue({
        code: "custom",
        message: "Release tag does not match publication channel.",
      });
    }
    for (const [name, values] of [
      ["artifacts", request.artifacts.map((item) => item.name)],
      ["publicationScope", request.publicationScope],
    ] as const) {
      if (new Set(values).size !== values.length) {
        context.addIssue({ code: "custom", message: `Duplicate ${name} entries.` });
      }
    }
  });
export type FastTrackRequest = z.infer<typeof fastTrackRequestSchema>;

export function parseFastTrackRequest(value: unknown): FastTrackRequest {
  return fastTrackRequestSchema.parse(value);
}

/** Canonical review contents. Serialization and its digest do not confer approval authority. */
export function serializeFastTrackRequest(value: unknown): string {
  const request = parseFastTrackRequest(value);
  // Zod emits schema key order. Arrays representing sets use explicit ASCII ordering.
  const canonical = {
    ...request,
    artifacts: request.artifacts.toSorted((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    ),
    publicationScope: request.publicationScope.toSorted(),
  };
  return JSON.stringify(canonical);
}

export function fastTrackRequestDigest(value: unknown): string {
  return `sha256:${createHash("sha256").update(serializeFastTrackRequest(value)).digest("hex")}`;
}

const validatedReferenceSchema = z.strictObject({
  repository,
  releaseTag,
  targetSha: sha,
  validationEvidenceDigest: digest,
  validationMode: z.literal("full-release-validation"),
  published: z.literal(true),
});
export type ValidatedFastTrackReference = z.infer<typeof validatedReferenceSchema>;

/**
 * Eligibility only. The publisher must separately authenticate reference evidence, verify the
 * human decision for fastTrackRequestDigest(request), and retain package/publication gates.
 * A previous fast-track release is not valid reference evidence.
 */
export function collectFastTrackEligibility(input: {
  repositoryRoot: string;
  request: unknown;
  validatedReference: unknown;
}): { commits: number; added: number; deleted: number } {
  const request = parseFastTrackRequest(input.request);
  const reference = validatedReferenceSchema.parse(input.validatedReference);
  if (
    reference.repository !== request.repository ||
    reference.releaseTag !== request.reference.releaseTag ||
    reference.targetSha !== request.reference.targetSha ||
    reference.validationEvidenceDigest !== request.reference.validationEvidenceDigest
  ) {
    throw new Error("Published fully validated reference does not match the request.");
  }
  const git = (...args: string[]) =>
    execFileSync("git", ["--no-replace-objects", "-C", input.repositoryRoot, ...args], {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, GIT_NO_REPLACE_OBJECTS: "1", GIT_OPTIONAL_LOCKS: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
  if (git("rev-parse", "--is-shallow-repository").trim() !== "false") {
    throw new Error("Fast-track eligibility requires complete Git history.");
  }
  for (const commit of [reference.targetSha, request.candidateSha]) {
    if (git("cat-file", "-t", commit).trim() !== "commit") {
      throw new Error("Fast-track source identity must be a commit.");
    }
  }
  try {
    git("merge-base", "--is-ancestor", reference.targetSha, request.candidateSha);
  } catch {
    throw new Error("Published fully validated reference must be an ancestor of the candidate.");
  }
  const commits = Number(
    git("rev-list", "--count", `${reference.targetSha}..${request.candidateSha}`).trim(),
  );
  const diffArgs = [
    "--no-ext-diff",
    "--no-textconv",
    "--no-renames",
    "--ignore-submodules=none",
    reference.targetSha,
    request.candidateSha,
    "--",
  ];
  // Inspect blobs too: candidate .gitattributes must not disguise a binary as a text diff.
  const raw = git("diff", "--raw", "--no-abbrev", "-z", ...diffArgs).split("\0");
  const blobs = new Set<string>();
  for (let index = 0; index < raw.length - 1; index += 2) {
    const header = raw[index] ?? "";
    const match = /^:([0-7]{6}) ([0-7]{6}) ([a-f0-9]{40}) ([a-f0-9]{40}) [AMDT]$/u.exec(header);
    const [, oldMode = "", newMode = "", oldBlob = "", newBlob = ""] = match ?? [];
    if (!match || [oldMode, newMode].some((mode) => mode !== "000000" && !mode.startsWith("100"))) {
      throw new Error("Fast-track delta contains an unmeasurable file change.");
    }
    for (const blob of [oldBlob, newBlob]) {
      if (blob !== "0".repeat(40)) {
        blobs.add(blob);
      }
    }
  }
  for (const blob of blobs) {
    if (git("cat-file", "blob", blob).includes("\0")) {
      throw new Error("Fast-track delta contains a binary change.");
    }
  }
  let added = 0;
  let deleted = 0;
  const stats = git("diff", "--numstat", "-z", ...diffArgs)
    .split("\0")
    .filter(Boolean);
  for (const entry of stats) {
    const match = /^([0-9]+)\t([0-9]+)\t/su.exec(entry);
    if (!match) {
      throw new Error("Fast-track delta contains a binary or unmeasurable change.");
    }
    added += Number(match[1]);
    deleted += Number(match[2]);
  }
  if (
    !Number.isSafeInteger(commits) ||
    !Number.isSafeInteger(added + deleted) ||
    commits > 10 ||
    added + deleted > 1000
  ) {
    throw new Error("Fast-track requires at most 10 commits and at most 1000 added/deleted lines.");
  }
  if (
    commits !== request.delta.commits ||
    added !== request.delta.added ||
    deleted !== request.delta.deleted
  ) {
    throw new Error("Publisher-computed delta does not match the approval request.");
  }
  return { commits, added, deleted };
}
