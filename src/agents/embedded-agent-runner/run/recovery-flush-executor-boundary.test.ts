import { describe, expect, it } from "vitest";
import { applyEmbeddedRunRecoveryFlushExecutor } from "../run-orchestrator.js";
import type { RunEmbeddedAgentParams } from "./params.js";

describe("applyEmbeddedRunRecoveryFlushExecutor", () => {
  it("defaults the recovery flush executor for direct embedded runs", () => {
    // Direct, cron, and gateway callers do not inject the maintenance executor;
    // the shared runner boundary must supply it so recovery preserves durable
    // memory instead of hitting the unavailable-executor skip.
    const params = {
      runId: "direct-run",
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      config: {},
      workspaceDir: "/tmp/workspace",
      prompt: "continue",
      timeoutMs: 30_000,
    } as RunEmbeddedAgentParams;
    const applied = applyEmbeddedRunRecoveryFlushExecutor(params);
    expect(applied).not.toBe(params);
    expect(applied.runRecoveryMemoryFlushTurn).toEqual(expect.any(Function));
  });

  it("preserves an explicitly injected recovery flush executor", () => {
    const injected = async () => ({ meta: {} as never, payloads: [] });
    const params = {
      runId: "auto-reply-run",
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      config: {},
      workspaceDir: "/tmp/workspace",
      prompt: "continue",
      timeoutMs: 30_000,
      runRecoveryMemoryFlushTurn: injected,
    } as RunEmbeddedAgentParams;
    const applied = applyEmbeddedRunRecoveryFlushExecutor(params);
    expect(applied.runRecoveryMemoryFlushTurn).toBe(injected);
  });
});
