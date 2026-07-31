import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { PluginDoctorStateMigrationContext } from "openclaw/plugin-sdk/runtime-doctor";
import { describe, expect, it } from "vitest";
import { stateMigrations } from "./doctor-contract-api.js";

describe("Codex sidecar migration ownership", () => {
  it("detects the physical-main sidecar for a sole-agent install", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-sole-sidecar-"));
    const sessionsDir = path.join(stateDir, "sessions");
    const transcriptPath = path.join(sessionsDir, "legacy.jsonl");
    await fs.mkdir(sessionsDir, { recursive: true });
    await fs.writeFile(transcriptPath, `${JSON.stringify({ type: "session", id: "legacy" })}\n`);
    await fs.writeFile(
      `${transcriptPath}.codex-app-server.json`,
      JSON.stringify({ schemaVersion: 2, threadId: "thread-legacy" }),
    );
    const migration = stateMigrations[0];
    if (!migration) {
      throw new Error("missing Codex binding migration");
    }

    try {
      await expect(
        migration.detectLegacyState({
          config: { agents: { entries: { ops: {} } } },
          env: { OPENCLAW_STATE_DIR: stateDir },
          stateDir,
          oauthDir: path.join(stateDir, "oauth"),
          context: {} as PluginDoctorStateMigrationContext,
        }),
      ).resolves.toMatchObject({
        preview: [expect.stringContaining("Codex app-server bindings")],
      });
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });
});
