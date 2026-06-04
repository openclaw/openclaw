import { execFileSync } from "node:child_process";

const DEFAULT_GIT_OUTPUT_MAX_BUFFER = 16 * 1024 * 1024;

export function resolveMergeHeadDiffBase({
  base,
  head = "HEAD",
  cwd = process.cwd(),
  maxBuffer = DEFAULT_GIT_OUTPUT_MAX_BUFFER,
  preferFirstParent = false,
}) {
  if (!base) {
    return "";
  }
  if (!preferFirstParent) {
    return base;
  }

  const parents = listCommitParents({ ref: head, cwd, maxBuffer });
  if (parents.length < 2) {
    return base;
  }

  const firstParent = resolveCommit({ ref: parents[0], cwd, maxBuffer });
  const explicitBase = resolveCommit({ ref: base, cwd, maxBuffer });
  if (!firstParent || firstParent === explicitBase) {
    return base;
  }

  return firstParent;
}

function listCommitParents({ ref, cwd, maxBuffer }) {
  try {
    const output = execFileSync("git", ["rev-list", "--parents", "-n", "1", ref], {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
      maxBuffer,
    }).trim();
    return output.split(/\s+/u).slice(1);
  } catch {
    return [];
  }
}

function resolveCommit({ ref, cwd, maxBuffer }) {
  try {
    return execFileSync("git", ["rev-parse", "--verify", `${ref}^{commit}`], {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
      maxBuffer,
    }).trim();
  } catch {
    return "";
  }
}
