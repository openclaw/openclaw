// Producer and verifier identities are independent of release result projection.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const SHA_PINNED_BRANCH_PATTERN = /^release-ci\/[a-f0-9]{12}-[1-9][0-9]*$/u;
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

export function validateTrustedProducerIdentity(
  evidence,
  client,
  verifier,
  trustedWorkflowRef,
  trustedWorkflowFullRef,
  trustedWorkflowSha,
) {
  const { manifest, parentRun } = evidence;
  const trustedIdentity = resolveTrustedWorkflowIdentity(
    trustedWorkflowRef,
    trustedWorkflowFullRef,
    trustedWorkflowSha,
  );
  const shaPinned = SHA_PINNED_BRANCH_PATTERN.test(manifest.workflowRef ?? "");
  const protectedTagRoute = trustedIdentity.type === "tag";
  let protectedTagWorkflowRefProof = "manifest-v3-protected-tag-exact-sha";
  if (protectedTagRoute) {
    let liveTag;
    try {
      liveTag = client.getRef(trustedIdentity.fullRef);
    } catch (error) {
      throw new Error(
        `protected tooling tag is unavailable: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }
    if (liveTag?.object?.sha !== trustedIdentity.sha) {
      throw new Error("protected tooling tag moved after release validation was sealed");
    }
    if (!shaPinned) {
      throw new Error("protected-tag release evidence must use a canonical release-ci branch");
    }
    if (manifest.workflowSha !== trustedIdentity.sha) {
      const comparison = client.compareCommitLineage(manifest.workflowSha, trustedIdentity.sha);
      if (
        !["ahead", "identical"].includes(String(comparison.status)) ||
        comparison.merge_base_commit?.sha !== manifest.workflowSha
      ) {
        throw new Error(
          "protected-tag release evidence producer is not on the trusted tooling lineage",
        );
      }
      protectedTagWorkflowRefProof = "manifest-v3-protected-tag-tooling-lineage";
    }
  } else if (manifest.workflowRef !== trustedWorkflowRef && !shaPinned) {
    throw new Error(
      `release evidence producer must run from trusted workflow ref: ${trustedWorkflowRef}`,
    );
  }
  if (shaPinned) {
    if (manifest.version < 3) {
      throw new Error("SHA-pinned release evidence requires a v3+ manifest");
    }
    if (!manifest.workflowRef.startsWith(`release-ci/${manifest.workflowSha.slice(0, 12)}-`)) {
      throw new Error("SHA-pinned release evidence branch does not match its workflow SHA");
    }
    if (manifest.targetRef !== manifest.targetSha) {
      throw new Error("SHA-pinned release evidence target ref must equal its target SHA");
    }
  }
  const expectedFullRef = `refs/heads/${manifest.workflowRef}`;
  const runPath = String(parentRun.path ?? "");
  const [runWorkflowPath, runWorkflowFullRef] = runPath.split("@", 2);
  if (runWorkflowPath !== ".github/workflows/full-release-validation.yml") {
    throw new Error("release evidence producer workflow path is not trusted");
  }
  if (runWorkflowFullRef && normalizeWorkflowPathRef(runWorkflowFullRef) !== expectedFullRef) {
    throw new Error("release evidence producer workflow full ref is not trusted");
  }

  let workflowRefProof = "legacy-v2-main-ancestry";
  if (manifest.version >= 3) {
    if (manifest.workflowRefType !== "branch" || manifest.workflowFullRef !== expectedFullRef) {
      throw new Error("release evidence producer workflow full ref is not trusted");
    }
    workflowRefProof = protectedTagRoute
      ? protectedTagWorkflowRefProof
      : shaPinned
        ? "manifest-v3-sha-pinned-main-ancestry"
        : "manifest-v3-branch";
  }

  if (!protectedTagRoute) {
    const comparison = client.compareCommitLineage(manifest.workflowSha, verifier.sourceSha);
    if (
      !["ahead", "identical"].includes(String(comparison.status)) ||
      comparison.merge_base_commit?.sha !== manifest.workflowSha
    ) {
      throw new Error("release evidence producer is not on the trusted main verifier lineage");
    }
  }

  return {
    producerOnTrustedMainLineage: !protectedTagRoute,
    workflowFullRef: expectedFullRef,
    workflowQualifiedPath: `${runWorkflowPath}@${expectedFullRef}`,
    workflowRefProof,
    workflowRefType: "branch",
    workflowRunPath: runPath,
  };
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
