import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import { startQaLabServer } from "./lab-server.js";

/**
 * QA self-check runs a real gateway loop in-process. Without an isolated state dir that loop
 * resolves the operator's `~/.openclaw` store, so a self-check on a machine with an older
 * installed OpenClaw dies on its schema instead of checking the source tree.
 */
async function withIsolatedQaStateDir<T>(run: () => Promise<T>): Promise<T> {
  const previous = process.env.OPENCLAW_STATE_DIR;
  const stateDir = await mkdtemp(
    path.join(resolvePreferredOpenClawTmpDir(), "openclaw-qa-self-check-"),
  );
  process.env.OPENCLAW_STATE_DIR = stateDir;
  try {
    return await run();
  } finally {
    if (previous === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previous;
    }
    await rm(stateDir, { recursive: true, force: true });
  }
}

export async function runQaE2eSelfCheck(params?: { repoRoot?: string; outputPath?: string }) {
  return await withIsolatedQaStateDir(async () => {
    const server = await startQaLabServer({
      repoRoot: params?.repoRoot,
      outputPath: params?.outputPath,
    });
    try {
      return await server.runSelfCheck();
    } finally {
      await server.stop();
    }
  });
}
