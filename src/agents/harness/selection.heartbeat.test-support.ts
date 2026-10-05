import path from "node:path";
import { expect, it, vi } from "vitest";
import type { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import {
  claimHeartbeatOutcomeForRun,
  persistHeartbeatOutcome,
} from "../../infra/heartbeat-outcome-store.js";
import type {
  EmbeddedRunAttemptParams,
  EmbeddedRunAttemptResult,
} from "../embedded-agent-runner/run/types.js";
import { runAgentHarnessAttempt } from "./selection.js";
import type { AgentHarness } from "./types.js";

export function registerHarnessHeartbeatOutcomeTests(fixture: {
  trajectoryTempDirs: ReturnType<typeof createTempDirTracker>;
  createAttemptParams: (config?: OpenClawConfig) => EmbeddedRunAttemptParams;
  createAttemptResult: (sessionIdUsed: string) => EmbeddedRunAttemptResult;
  registerHarness: (overrides: Partial<AgentHarness>) => unknown;
}) {
  const { trajectoryTempDirs, createAttemptParams, createAttemptResult, registerHarness } = fixture;
  it("carries silent heartbeat outcome into the plugin host boundary exactly once per retry", async () => {
    const harnessId = "codex";
    const root = trajectoryTempDirs.make("harness-heartbeat-outcome-");
    vi.stubEnv("OPENCLAW_STATE_DIR", root);
    const target = {
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:main:main",
      storePath: path.join(root, "agent.sqlite"),
    };
    await replaceSessionEntry(target, { sessionId: target.sessionId, updatedAt: 1 });
    await persistHeartbeatOutcome({
      ...target,
      runSessionKey: "agent:main:main:heartbeat",
      occurredAt: 1,
      response: { outcome: "done", notify: false, summary: "ISOLATED_OUTCOME_731" },
    });
    const runAttempt = vi.fn<AgentHarness["runAttempt"]>(async () => createAttemptResult("native"));
    registerHarness({ runAttempt });
    const currentInboundContext = {
      text: "Current quoted reply",
      resumableText: "Current room delta",
      promptJoiner: "\n" as const,
      fragments: [{ kind: "conversation-data" as const, text: "Current quoted reply" }],
    };
    const params = {
      ...createAttemptParams(),
      ...target,
      sessionTarget: target,
      trigger: "user" as const,
      agentHarnessId: harnessId,
      currentInboundContext,
    };
    for (let retry = 0; retry < 2; retry++) {
      await runAgentHarnessAttempt(params);
      const received = runAttempt.mock.calls.at(-1)?.[0];
      expect(received?.currentInboundContext?.text.match(/ISOLATED_OUTCOME_731/g)).toHaveLength(1);
      expect(
        received?.currentInboundContext?.resumableText?.match(/ISOLATED_OUTCOME_731/g),
      ).toHaveLength(1);
      expect(received?.currentInboundContext?.promptJoiner).toBe("\n");
      const fragments = received?.currentInboundContext?.fragments;
      expect(fragments).toEqual([
        ...currentInboundContext.fragments,
        { kind: "heartbeat-outcome", text: expect.stringContaining("ISOLATED_OUTCOME_731") },
      ]);
      expect(JSON.stringify(fragments)).toContain("ISOLATED_OUTCOME_731");
      expect(received?.prompt).toBe("hello");
      expect(params.currentInboundContext).toEqual(currentInboundContext);
      expect(currentInboundContext.text).toBe("Current quoted reply");
    }
    expect(JSON.stringify(await loadTranscriptEvents(target))).not.toContain(
      "ISOLATED_OUTCOME_731",
    );
    expect(
      await claimHeartbeatOutcomeForRun({ ...target, runId: "later-user-run" }),
    ).toBeUndefined();
  });

  it("does not consume silent heartbeat context for an aborted host attempt", async () => {
    const root = trajectoryTempDirs.make("harness-heartbeat-control-");
    vi.stubEnv("OPENCLAW_STATE_DIR", root);
    const target = {
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:main:main",
      storePath: path.join(root, "agent.sqlite"),
    };
    await replaceSessionEntry(target, { sessionId: target.sessionId, updatedAt: 1 });
    await persistHeartbeatOutcome({
      ...target,
      runSessionKey: "agent:main:main:heartbeat",
      occurredAt: 1,
      response: { outcome: "done", notify: false, summary: "Retained outcome" },
    });
    const params = {
      ...createAttemptParams(),
      ...target,
      sessionTarget: target,
      trigger: "user" as const,
      abortSignal: AbortSignal.abort(),
    };
    await expect(runAgentHarnessAttempt(params)).rejects.toThrow();
    expect((await claimHeartbeatOutcomeForRun({ ...target, runId: "next-user" }))?.summary).toBe(
      "Retained outcome",
    );
  });
}
