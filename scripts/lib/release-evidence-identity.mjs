// Producer and verifier identities are independent of release result projection.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const TRUSTED_RELEASE_PUBLISH_TAG_PATTERN =
  /^refs\/tags\/release-publish\/([a-f0-9]{12})-[1-9][0-9]*$/u;
const RELEASE_EVIDENCE_SCRIPT = "scripts/release-ci-summary.mjs";
export const RELEASE_EVIDENCE_FILE = fileURLToPath(
  new URL("../release-ci-summary.mjs", import.meta.url),
);
const RELEASE_EVIDENCE_REPO_ROOT = resolve(dirname(RELEASE_EVIDENCE_FILE), "..");

export function normalizeSha(value, label) {
  const sha = String(value ?? "");
  if (!/^[a-f0-9]{40}$/u.test(sha)) {
    throw new Error(`${label} is invalid`);
  }
  return sha;
}

export function resolveTrustedWorkflowIdentity(workflowRef, workflowFullRef, workflowSha) {
  const fullRef = workflowFullRef ?? `refs/heads/${workflowRef}`;
  const protectedTag = TRUSTED_RELEASE_PUBLISH_TAG_PATTERN.exec(fullRef);
  if (protectedTag) {
    if (workflowRef !== fullRef.slice("refs/tags/".length)) {
      throw new Error("trusted workflow tag name does not match its full ref");
    }
    const sha = normalizeSha(workflowSha, "trusted workflow SHA");
    if (sha.slice(0, 12) !== protectedTag[1]) {
      throw new Error("trusted workflow tag does not match its workflow SHA");
    }
    return { fullRef, ref: workflowRef, sha, type: "tag" };
  }
  if (fullRef !== `refs/heads/${workflowRef}`) {
    throw new Error("trusted workflow full ref does not match its ref");
  }
  if (workflowRef.startsWith("release-publish/")) {
    throw new Error("trusted release-publish workflow ref must be a protected tag");
  }
  return { fullRef, ref: workflowRef, sha: undefined, type: "branch" };
}

export function normalizeWorkflowPathRef(ref) {
  if (!ref || ref.startsWith("refs/")) {
    return ref;
  }
  return `refs/heads/${ref}`;
}

// This projects an eligible retained producer context. Only the strict FRV
// verifier authenticates both admissions and the unchanged artifact descriptors.
export function retainedPublicationArtifactSource(manifest) {
  const reuse = manifest?.evidenceReuse;
  const current = manifest?.sourceAdmission;
  const retained = reuse?.publication?.sourceAdmission;
  if (
    reuse?.policy !== "exact-target-full-validation-v1" ||
    !Array.isArray(reuse.changedPaths) ||
    reuse.changedPaths.length !== 0 ||
    String(reuse.runId) !== String(reuse.selectedRunId) ||
    !/^[a-f0-9]{40}$/u.test(manifest?.targetSha ?? "") ||
    reuse.evidenceSha !== manifest.targetSha ||
    String(retained?.runId) !== String(reuse.runId) ||
    String(current?.runId) !== String(manifest.runId) ||
    current?.candidateSha !== manifest.targetSha ||
    retained?.candidateSha !== manifest.targetSha ||
    current?.workflow?.sha !== manifest.workflowSha ||
    retained?.workflow?.sha !== manifest.workflowSha ||
    !current?.qualificationAdmission ||
    !retained?.qualificationAdmission ||
    typeof retained.workflow.ref !== "string"
  ) {
    return null;
  }
  return retained;
}

export function resolveVerifierIdentity(
  sourceSha,
  verifierSourceContent,
  repositoryRoot = RELEASE_EVIDENCE_REPO_ROOT,
) {
  let normalizedSourceSha = sourceSha ?? process.env.GITHUB_SHA;
  if (!/^[a-f0-9]{40}$/u.test(String(normalizedSourceSha ?? ""))) {
    try {
      normalizedSourceSha = execFileSync("git", ["-C", repositoryRoot, "rev-parse", "HEAD"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      normalizedSourceSha = null;
    }
  }
  if (!/^[a-f0-9]{40}$/u.test(String(normalizedSourceSha ?? ""))) {
    throw new Error("release evidence verifier source SHA is unavailable");
  }
  const script = readFileSync(RELEASE_EVIDENCE_FILE);
  const scriptSha256 = createHash("sha256").update(script).digest("hex");
  let sourceScript;
  if (verifierSourceContent !== undefined) {
    sourceScript = Buffer.from(verifierSourceContent);
  } else {
    try {
      sourceScript = execFileSync(
        "git",
        ["-C", repositoryRoot, "show", `${normalizedSourceSha}:${RELEASE_EVIDENCE_SCRIPT}`],
        {
          // Evidence verification must stay local-deterministic: in a partial
          // clone a missing blob would otherwise trigger a promisor network
          // fetch (hang/minutes) inside this security check.
          env: { ...process.env, GIT_NO_LAZY_FETCH: "1" },
          maxBuffer: 16 * 1024 * 1024,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
    } catch {
      throw new Error("release evidence verifier source blob is unavailable");
    }
  }
  const sourceScriptSha256 = createHash("sha256").update(sourceScript).digest("hex");
  if (scriptSha256 !== sourceScriptSha256) {
    throw new Error("release evidence verifier script differs from its source SHA");
  }
  return {
    schemaVersion: 3,
    script: RELEASE_EVIDENCE_SCRIPT,
    scriptSha256,
    sourceSha: normalizedSourceSha,
  };
}
