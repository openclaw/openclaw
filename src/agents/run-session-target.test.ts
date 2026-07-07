import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadSessionStore } from "../config/sessions/store.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveAgentRunSessionTarget } from "./run-session-target.js";

describe("agent run session target", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-run-session-target-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("resolves runtime identity through the run config store", async () => {
    const storePath = path.join(tempDir, "custom-sessions", "sessions.json");
    const sessionKey = "agent:helper:commitments:test-run";

    const target = await resolveAgentRunSessionTarget({
      agentId: "helper",
      config: { session: { store: storePath } } as OpenClawConfig,
      sessionId: "test-run",
      sessionKey,
    });

    expect(target).toMatchObject({
      agentId: "helper",
      sessionId: "test-run",
      sessionKey,
    });
    expect(path.dirname(target.sessionFile)).toBe(path.dirname(storePath));
    expect(loadSessionStore(storePath, { skipCache: true })[sessionKey]?.sessionFile).toBe(
      target.sessionFile,
    );
  });

  it("uses the agent from an agent-scoped session key when agentId is omitted", async () => {
    const storeRoot = path.join(tempDir, "agents", "{agentId}", "sessions.json");
    const sessionKey = "agent:helper:main";

    const target = await resolveAgentRunSessionTarget({
      config: { session: { store: storeRoot } } as OpenClawConfig,
      sessionId: "helper-session",
      sessionKey,
    });

    const helperStorePath = path.join(tempDir, "agents", "helper", "sessions.json");
    expect(target.agentId).toBe("helper");
    expect(path.dirname(target.sessionFile)).toBe(path.dirname(helperStorePath));
    expect(loadSessionStore(helperStorePath, { skipCache: true })[sessionKey]?.sessionFile).toBe(
      target.sessionFile,
    );
  });
});
