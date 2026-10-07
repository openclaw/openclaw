import type { Model } from "openclaw/plugin-sdk/llm";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { toToolDefinitions } from "../agent-tool-definition-adapter.js";
import { wrapToolWithAbortSignal } from "../agent-tools.abort.js";
import type { AnyAgentTool } from "../agent-tools.types.js";
import {
  queueSessionsYieldInterruptMessage,
  SESSIONS_YIELD_ABORT_REASON,
} from "../embedded-agent-runner/run/attempt-sessions-yield.js";
import { createSessionsYieldTool } from "../tools/sessions-yield-tool.js";
import {
  createAssistant,
  createAssistantResultStream,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
} from "./agent-session-loop-correctness.test-support.js";
import type { AgentSession } from "./agent-session.js";

registerAgentSessionLoopTestLifecycle();

describe("AgentSession sessions_yield sibling calls", () => {
  it.each([
    { name: "sessions_yield hands off the turn", reason: SESSIONS_YIELD_ABORT_REASON },
    { name: "the run is aborted for another reason", reason: new Error("user stopped the run") },
  ])("settles same-message siblings when $name", async ({ reason }) => {
    const handedOff = Promise.withResolvers<void>();
    const sideEffects: string[] = [];
    const sessionRef: { current?: AgentSession } = {};
    const runAbort = new AbortController();
    const sibling = (name: string, gate?: Promise<void>): AnyAgentTool => ({
      name,
      label: name,
      description: name,
      parameters: Type.Object({}),
      execute: async (_id, _args, signal) => {
        await gate;
        // A channel send checks its signal right before the final write.
        signal?.throwIfAborted();
        sideEffects.push(name);
        return { content: [{ type: "text", text: `${name} done` }], details: {} };
      },
    });
    const yieldTool = createSessionsYieldTool({
      sessionId: "yield-siblings",
      claimYield: () => true,
      // Same sequence as the embedded attempt's onYield.
      onYield: () => {
        const session = sessionRef.current!;
        queueSessionsYieldInterruptMessage(session);
        runAbort.abort(reason);
        void session.abort(reason);
        handedOff.resolve();
      },
    });
    // Production composition: abort wrapper on the run signal, then session definitions.
    const tools = [
      sibling("message", handedOff.promise),
      sibling("sessions_spawn", handedOff.promise),
      yieldTool,
      sibling("late_sibling"),
    ].map((tool) => wrapToolWithAbortSignal(tool, runAbort.signal));
    let requests = 0;
    streamMocks.streamSimple.mockImplementation((activeModel: Model) => {
      requests += 1;
      return createAssistantResultStream(
        createAssistant(
          activeModel,
          ["message", "sessions_spawn", "sessions_yield", "late_sibling"].map((name) => ({
            type: "toolCall" as const,
            id: `call-${name}`,
            name,
            arguments: {},
          })),
          "toolUse",
        ),
      );
    });
    const { session } = await createTestSession({
      customTools: toToolDefinitions(tools, undefined, runAbort.signal),
    });
    sessionRef.current = session;

    await session.prompt("post the update, spawn the worker, then wait").catch(() => undefined);
    await session.agent.waitForIdle();

    const handoff = reason === SESSIONS_YIELD_ABORT_REASON;
    expect(requests).toBe(1);
    expect(sideEffects).toEqual(handoff ? ["message", "sessions_spawn", "late_sibling"] : []);
    const results = session.messages.filter((message) => message.role === "toolResult");
    expect(results.map((result) => [result.toolName, result.isError])).toEqual([
      ["message", !handoff],
      ["sessions_spawn", !handoff],
      ["sessions_yield", !handoff],
      ["late_sibling", !handoff],
    ]);
  });
});
