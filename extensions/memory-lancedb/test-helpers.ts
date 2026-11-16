// Memory Lancedb helper module supports test helpers behavior.
import fs from "node:fs/promises";
import path from "node:path";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import { afterEach, beforeEach } from "vitest";

export function installTmpDirHarness(params: { prefix: string }) {
  let tmpDir = "";
  let dbPath = "";

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(resolvePreferredOpenClawTmpDir(), params.prefix));
    dbPath = path.join(tmpDir, "lancedb");
  });

  afterEach(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  return {
    getTmpDir: () => tmpDir,
    getDbPath: () => dbPath,
  };
}

/**
 * Runs a tool or hook as the owner's direct chat with the context's agent, the only session
 * that may recall or forget stored memories by default. A context's own memoryAudience wins.
 */
export function withOwnerChat<T extends Record<string, unknown>>(ctx: T) {
  return { memoryAudience: { kind: "owner-private", agentId: ctx.agentId ?? "main" }, ...ctx };
}
