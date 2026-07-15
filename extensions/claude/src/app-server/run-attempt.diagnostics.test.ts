import {
  onInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  waitForDiagnosticEventsDrained,
  type DiagnosticEventPayload,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import { afterEach, describe, expect, it } from "vitest";
import type { ClaudeAppServerClient, ServerRequestHandler } from "./client.js";
import type { ClaudeDynamicToolBridge } from "./dynamic-tools.js";
import { registerToolCallHandler } from "./run-attempt.js";
import type { DynamicToolCallParams, DynamicToolCallResponse } from "./types.js";

// registerToolCallHandler feeds the gateway's stalled-session watchdog
// (src/logging/diagnostic-run-activity.ts touches lastProgressAt on
// tool.execution.*). Without these events, a turn doing many sequential
// dynamic tool calls with little/no intervening assistant text never
// refreshes its progress marker past the initial embedded_run:started
// touch, making a genuinely busy turn indistinguishable from a hang and
// triggering the gateway's stuck-session-recovery abort (openclaw-7f5).

function makeFakeClient(): {
  client: ClaudeAppServerClient;
  dispatch: (req: { method: string; params?: unknown }) => Promise<unknown>;
} {
  let handler: ServerRequestHandler | undefined;
  const client = {
    onServerRequest(next: ServerRequestHandler) {
      handler = next;
      return () => {
        handler = undefined;
      };
    },
  } as unknown as ClaudeAppServerClient;
  return {
    client,
    dispatch: async (req) => {
      if (!handler) {
        throw new Error("no handler registered");
      }
      return await handler({ id: 1, method: req.method, params: req.params as never });
    },
  };
}

function makeFakeBridge(
  impl: (call: DynamicToolCallParams) => Promise<DynamicToolCallResponse>,
): ClaudeDynamicToolBridge {
  return {
    specs: [],
    telemetry: {
      didSendViaMessagingTool: false,
      messagingToolSentTexts: [],
      messagingToolSentMediaUrls: [],
      messagingToolSentTargets: [],
      messagingToolSourceReplyPayloads: [],
      toolMediaUrls: [],
      toolAudioAsVoice: false,
    },
    handleToolCall: impl,
  } as unknown as ClaudeDynamicToolBridge;
}

const CALL: DynamicToolCallParams = {
  threadId: "thread-1",
  turnId: "turn-1",
  callId: "call-1",
  tool: "Bash",
  arguments: { command: "echo hi" },
};

const IDENTITY = {
  agentId: "main",
  runId: "run-1",
  sessionId: "session-1",
  sessionKey: "agent:main:direct:eddie",
};

async function collectToolExecutionEvents(
  run: () => Promise<unknown>,
): Promise<DiagnosticEventPayload[]> {
  const events: DiagnosticEventPayload[] = [];
  const unsubscribe = onInternalDiagnosticEvent((event) => {
    if (event.type.startsWith("tool.execution.")) {
      events.push(event);
    }
  });
  try {
    await run();
    await waitForDiagnosticEventsDrained();
  } finally {
    unsubscribe();
  }
  return events;
}

describe("registerToolCallHandler diagnostics", () => {
  afterEach(() => {
    resetDiagnosticEventsForTest();
  });

  it("emits tool.execution.started then tool.execution.completed for a successful call", async () => {
    const { client, dispatch } = makeFakeClient();
    const bridge = makeFakeBridge(async () => ({ contentItems: [], success: true }));
    registerToolCallHandler(client, bridge, { threadId: "thread-1", turnId: "turn-1" }, IDENTITY);

    const events = await collectToolExecutionEvents(() =>
      dispatch({ method: "item/tool/call", params: CALL }),
    );

    expect(events.map((e) => e.type)).toEqual([
      "tool.execution.started",
      "tool.execution.completed",
    ]);
    for (const event of events) {
      expect(event).toMatchObject({
        agentId: IDENTITY.agentId,
        runId: IDENTITY.runId,
        sessionId: IDENTITY.sessionId,
        sessionKey: IDENTITY.sessionKey,
        toolName: "Bash",
        toolCallId: "call-1",
      });
    }
  });

  it("emits tool.execution.error and rethrows when the bridge call fails", async () => {
    const { client, dispatch } = makeFakeClient();
    const bridge = makeFakeBridge(async () => {
      throw new Error("tool call blew up");
    });
    registerToolCallHandler(client, bridge, { threadId: "thread-1", turnId: "turn-1" }, IDENTITY);

    let caught: unknown;
    const events = await collectToolExecutionEvents(async () => {
      try {
        await dispatch({ method: "item/tool/call", params: CALL });
      } catch (error) {
        caught = error;
      }
    });

    expect((caught as Error)?.message).toBe("tool call blew up");
    expect(events.map((e) => e.type)).toEqual(["tool.execution.started", "tool.execution.error"]);
    const errorEvent = events[1] as Extract<
      DiagnosticEventPayload,
      { type: "tool.execution.error" }
    >;
    expect(errorEvent.errorCategory).toBe("claude_dynamic_tool_error");
    expect(errorEvent.toolCallId).toBe("call-1");
  });

  it("does not claim a request for a different turn (no diagnostics emitted)", async () => {
    const { client, dispatch } = makeFakeClient();
    const bridge = makeFakeBridge(async () => ({ contentItems: [], success: true }));
    registerToolCallHandler(client, bridge, { threadId: "thread-1", turnId: "turn-1" }, IDENTITY);

    const events = await collectToolExecutionEvents(async () => {
      const result = await dispatch({
        method: "item/tool/call",
        params: { ...CALL, turnId: "some-other-turn" },
      });
      expect(result).toBeUndefined();
    });

    expect(events).toEqual([]);
  });
});
