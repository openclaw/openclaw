import fs from "node:fs";
import { readJsonFileWithFallback, writeJsonFileAtomically } from "openclaw/plugin-sdk/msteams";
import { withFileLock as withPathLock } from "./file-lock.js";
const STORE_LOCK_OPTIONS = {
  retries: {
    retries: 10,
    factor: 2,
    minTimeout: 100,
    maxTimeout: 1e4,
    randomize: true
  },
  stale: 3e4
};
async function readJsonFile(filePath, fallback) {
  return await readJsonFileWithFallback(filePath, fallback);
}
async function writeJsonFile(filePath, value) {
  await writeJsonFileAtomically(filePath, value);
}
async function ensureJsonFile(filePath, fallback) {
  try {
    await fs.promises.access(filePath);
  } catch {
    await writeJsonFile(filePath, fallback);
  }
}
async function withFileLock(filePath, fallback, fn) {
  await ensureJsonFile(filePath, fallback);
  return await withPathLock(filePath, STORE_LOCK_OPTIONS, async () => {
    return await fn();
  });
}
export {
  readJsonFile,
  withFileLock,
  writeJsonFile
};
