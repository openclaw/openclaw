import fs from "node:fs";
import path from "node:path";

function sleepMs(ms) {
  const buf = new SharedArrayBuffer(4);
  const view = new Int32Array(buf);
  Atomics.wait(view, 0, 0, ms);
}

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function acquireLockSync(lockPath, timeoutMs = 8000, pollMs = 20) {
  const start = Date.now();
  while (true) {
    try {
      return fs.openSync(lockPath, "wx");
    } catch (err) {
      if (!(err && typeof err === "object" && "code" in err) || err.code !== "EEXIST") {
        throw err;
      }
      if (Date.now() - start > timeoutMs) {
        throw new Error(`lock timeout: ${lockPath}`);
      }
      sleepMs(pollMs);
    }
  }
}

function releaseLockSync(lockFd, lockPath) {
  try {
    fs.closeSync(lockFd);
  } finally {
    try {
      fs.unlinkSync(lockPath);
    } catch (err) {
      if (!(err && typeof err === "object" && "code" in err) || err.code !== "ENOENT") {
        throw err;
      }
    }
  }
}

export function withFileLockSync(filePath, fn) {
  const lockPath = `${filePath}.lock`;
  ensureParentDir(filePath);
  const lockFd = acquireLockSync(lockPath);
  try {
    return fn();
  } finally {
    releaseLockSync(lockFd, lockPath);
  }
}

export function readJsonWithFallbackSync(filePath, fallbackFactory) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallbackFactory();
  }
}

export function writeJsonAtomicSync(filePath, value) {
  ensureParentDir(filePath);
  const tempName = `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  const tempPath = path.join(path.dirname(filePath), tempName);
  fs.writeFileSync(tempPath, JSON.stringify(value, null, 2) + "\n");
  fs.renameSync(tempPath, filePath);
}
