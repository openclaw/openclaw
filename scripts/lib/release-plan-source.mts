import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import {
  verifyQualificationAdmission,
  type QualificationInputs,
} from "../release-qualification-admission.mjs";
import {
  resolveReleaseToolingIdentity,
  verifyReleaseToolingIdentity,
} from "../release-tooling-identity.mjs";

export type ReleaseInventorySource = {
  repoRoot?: string;
  candidateSha: string;
  toolingSha: string;
  toolingFullRef: string;
  qualificationAdmission?: unknown;
  qualificationInputs?: QualificationInputs;
  runGh?: (args: string[]) => string;
  downloadArchive?: (args: string[]) => Uint8Array;
};
const REPOSITORY = "openclaw/openclaw";
const git = (repoRoot: string, args: string[]) =>
  execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

export function resolveCommit(repoRoot: string, revision: string, label: string): string {
  let resolved: string;
  try {
    resolved = git(repoRoot, ["rev-parse", "--verify", `${revision}^{commit}`]);
  } catch {
    throw new Error(`${label} does not resolve to a commit: ${revision}`);
  }
  if (!/^[a-f0-9]{40}$/u.test(resolved)) {
    throw new Error(`${label} did not resolve to an exact lowercase commit SHA`);
  }
  return resolved;
}
function requireExactSha(value: string, label: string): string {
  if (!/^[a-f0-9]{40}$/u.test(value)) {
    throw new Error(`${label} must be an exact lowercase 40-character commit SHA`);
  }
  return value;
}
function requireQualifiedRef(value: string, label: string): string {
  if (!/^refs\/(?:heads|tags)\/[A-Za-z0-9._/-]+$/u.test(value)) {
    throw new Error(`${label} must be a qualified branch or tag ref`);
  }
  return value;
}

export function resolveSource(params: ReleaseInventorySource, inventoryOnly = false) {
  const repoRoot = resolve(params.repoRoot ?? ".");
  const candidateSha = requireExactSha(params.candidateSha, "candidate SHA");
  const toolingSha = requireExactSha(params.toolingSha, "tooling SHA");
  const toolingFullRef = requireQualifiedRef(params.toolingFullRef, "tooling full ref");
  if (resolveCommit(repoRoot, candidateSha, "candidate SHA") !== candidateSha) {
    throw new Error("candidate SHA does not resolve to itself");
  }
  const toolingRef = toolingFullRef.replace(/^refs\/(?:heads|tags)\//u, "");
  if (inventoryOnly) {
    resolveReleaseToolingIdentity({
      qualificationAdmission: params.qualificationAdmission,
      candidateSha,
      workflowContract: "2",
      requestedIdentityJson: JSON.stringify({
        ref: toolingRef,
        fullRef: toolingFullRef,
        sha: toolingSha,
      }),
      workflowFullRef: toolingFullRef,
      workflowRef: toolingRef,
      workflowSha: toolingSha,
    });
  }
  if (params.qualificationAdmission !== undefined) {
    if (!inventoryOnly || params.qualificationInputs === undefined) {
      throw new Error("Candidate inventory requires its complete qualification inputs");
    }
    verifyQualificationAdmission({
      descriptor: params.qualificationAdmission,
      repository: REPOSITORY,
      candidateSha,
      qualificationSha: toolingSha,
      workflowRef: toolingRef,
      inputs: params.qualificationInputs,
      runGh: params.runGh,
      downloadArchive: params.downloadArchive,
    });
    return {
      candidateSha,
      repoRoot,
      toolingFullRef,
      toolingSha,
      verifiedTooling: {
        ref: toolingRef,
        fullRef: toolingFullRef,
        sha: toolingSha,
        route: "candidate" as const,
      },
    };
  }
  const verifiedTooling = verifyReleaseToolingIdentity({
    allowPrevalidatedRef: inventoryOnly,
    repository: REPOSITORY,
    workflowFullRef: toolingFullRef,
    workflowRef: toolingRef,
    workflowSha: toolingSha,
    ...(params.runGh ? { runGh: params.runGh } : {}),
  });
  return { candidateSha, repoRoot, toolingFullRef, toolingSha, verifiedTooling };
}
