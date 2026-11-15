import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const executable = process.env.OPENCLAW_PR_GIT || process.env.GIT_EXEC || "git";
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const oidPattern = /^[a-f0-9]{40}$/u;
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const text = (...args) =>
  decoder.decode(execFileSync(executable, args, { maxBuffer: Infinity })).trim();

// Both lifecycle owners share these invocation-local replay facts when baseline
// proof admission calls continuation. They are never persisted admission tokens.
export const evidenceReplay = { files: undefined, directories: undefined };

// Empty resolution files are valid blobs. Read the opened regular descriptor once;
// Git receives those bytes without filters, pathname rereads or text normalization.
export function readRegular(path) {
  const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile()) {
      throw new Error(`Expected a regular file: ${path}`);
    }
    const bytes = fs.readFileSync(fd);
    const after = fs.fstatSync(fd);
    if (["size", "mtimeMs", "ctimeMs"].some((key) => before[key] !== after[key])) {
      throw new Error(`File changed while reading: ${path}`);
    }
    if (evidenceReplay.files) {
      const value = digest(bytes);
      if (Object.hasOwn(evidenceReplay.files, path) && evidenceReplay.files[path] !== value) {
        throw new Error("Preparation evidence changed during replay: " + path);
      }
      evidenceReplay.files[path] = value;
    }
    return bytes;
  } finally {
    fs.closeSync(fd);
  }
}

export function requireOperationOwner(pr, root, lockRef, lockOid) {
  if (lockRef !== `refs/openclaw/pr-operation-locks/${pr}` || !oidPattern.test(lockOid)) {
    throw new Error("Missing baseline transition operation owner.");
  }
  execFileSync("bash", [
    "-c",
    'source "$1"; pr_git() { "${OPENCLAW_PR_GIT:-${GIT_EXEC:-git}}" "$@"; }; pr_operation_lock_owner_is_current "$2" "$3" "$4"',
    "baseline-operation-owner",
    fileURLToPath(new URL("./operation-lock.sh", import.meta.url)),
    root,
    lockRef,
    lockOid,
  ]);
}

export function requireCheckout(source, anchor, branch, cwd, gitDir) {
  if (
    fs.realpathSync(".") !== cwd ||
    text("rev-parse", "--absolute-git-dir") !== gitDir ||
    text("symbolic-ref", "--short", "HEAD") !== branch ||
    ![source, anchor].includes(text("rev-parse", `refs/heads/${branch}`))
  ) {
    throw new Error("Baseline transition source or preparation branch changed.");
  }
}
