import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { loadSessionStore, type SessionEntry } from "../../config/sessions.js";
import type { EmbeddedPiRunResult } from "../pi-embedded.js";
import { updateSessionStoreAfterAgentRun } from "./session-store.js";

describe("updateSessionStoreAfterAgentRun", () => {
  let tmpDir: string;
  let storePath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-store-"));
    storePath = path.join(tmpDir, "sessions.json");
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("persists the runtime provider/model used by the completed run", async () => {
    const cfg = {
      agents: {
        defaults: {
          cliBackends: {
            "codex-cli": { command: "codex" },
          },
        },
      },
    } as OpenClawConfig;
    const sessionKey = "agent:main:explicit:test-codex-cli";
    const sessionId = "test-openclaw-session";
    const sessionStore: Record<string, SessionEntry> = {
      [sessionKey]: {
        sessionId,
        updatedAt: 1,
      },
    };
    await fs.writeFile(storePath, JSON.stringify(sessionStore, null, 2));

    const result: EmbeddedPiRunResult = {
      meta: {
        durationMs: 1,
        agentMeta: {
          sessionId: "cli-session-123",
          provider: "codex-cli",
          model: "gpt-5.4",
        },
      },
    };

    await updateSessionStoreAfterAgentRun({
      cfg,
      sessionId,
      sessionKey,
      storePath,
      sessionStore,
      defaultProvider: "codex-cli",
      defaultModel: "gpt-5.4",
      result,
    });

    expect(sessionStore[sessionKey]?.modelProvider).toBe("codex-cli");
    expect(sessionStore[sessionKey]?.model).toBe("gpt-5.4");

    const persisted = loadSessionStore(storePath);
    expect(persisted[sessionKey]?.modelProvider).toBe("codex-cli");
    expect(persisted[sessionKey]?.model).toBe("gpt-5.4");
  });
});
