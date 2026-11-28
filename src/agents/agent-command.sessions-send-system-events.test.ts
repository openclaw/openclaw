/** Tests that a sessions_send resume consumes the target session's passive notices. */
import { afterEach, expect, it } from "vitest";
import {
  enqueueSystemEventWithReceipt,
  peekSystemEvents,
  resetSystemEventsForTest,
} from "../infra/system-events.js";
import {
  agentCommandFromGatewayIngress,
  compactionTestState as state,
  GATEWAY_INGRESS_ARGS,
  makeCompactionResult,
  registerAgentCommandCompactionTestHooks,
} from "./agent-command.compaction.test-support.js";
import type { RuntimeContextFragment } from "./internal-runtime-context.js";

// Register hooks for this file, not as a cached support-module side effect.
registerAgentCommandCompactionTestHooks();
afterEach(() => resetSystemEventsForTest());

it.for(["sessions_send", "cli"] as const)(
  "drains a full passive queue only on a sessions_send resume: %s",
  async (caller) => {
    const sessionKey = "agent:main:subagent:passive-drain";
    const sessionId = "passive-drain-session";
    const adopted: boolean[] = [];
    // A long run leaves 20 unpolled exec completions, the passive pool's limit.
    for (let index = 0; index < 20; index++) {
      enqueueSystemEventWithReceipt(
        `Exec completed (${index})`,
        { sessionKey, contextKey: `exec:${index}` },
        { onSettled: (value) => adopted.push(value) },
      );
    }
    let fragments: RuntimeContextFragment[] | undefined;
    state.runAgentAttemptMock.mockImplementationOnce(async (params) => {
      fragments = params.opts.runtimeContextFragments;
      return makeCompactionResult({ sessionId, text: "done", runner: "embedded" });
    });

    await agentCommandFromGatewayIngress(
      {
        message: "Continue the task.",
        sessionKey,
        sessionId,
        runId: `passive-drain-${caller}`,
        allowModelOverride: false,
        ...(caller === "sessions_send"
          ? {
              inputProvenance: {
                kind: "inter_session" as const,
                sourceSessionKey: "agent:main:main",
                sourceTool: "sessions_send",
              },
            }
          : {}),
      },
      ...GATEWAY_INGRESS_ARGS,
    );

    if (caller === "cli") {
      expect(fragments).toBeUndefined();
      expect(peekSystemEvents(sessionKey)).toHaveLength(20);
      expect(adopted).toEqual([]);
      return;
    }
    expect(fragments).toEqual([
      { kind: "conversation-data", text: expect.stringContaining("Exec completed (0)") },
    ]);
    expect(fragments?.[0]?.text).toContain("Exec completed (19)");
    expect(peekSystemEvents(sessionKey)).toEqual([]);
    expect(adopted).toEqual(Array.from({ length: 20 }, () => true));
  },
);
