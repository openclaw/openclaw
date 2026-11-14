import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import type { AgentTool } from "openclaw/plugin-sdk/agent-core";
import { Type } from "typebox";
import { afterEach, expect, it, vi } from "vitest";
import {
  attachInternalToolExecutionPreparer,
  getInternalToolExecutionPreparer,
} from "../../../packages/agent-core/src/internal-hooks.js";
import { withinTest } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { toClientToolDefinitions, toToolDefinitions } from "../agent-tool-definition-adapter.js";
import { wrapToolWithBeforeToolCallHook } from "../agent-tools.before-tool-call.js";
import { guardSessionManager } from "../session-tool-result-guard-wrapper.js";
import {
  createTestSession,
  mockToolTurn as mockExchange,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
} from "./agent-session-loop-correctness.test-support.js";
import type { MessageEndEvent, ToolDefinition } from "./extensions/types.js";
import { sessionScope } from "./session-manager-fixtures.test-support.js";
import { SessionManager } from "./session-manager.js";
import { cleanupTrackedSessionState } from "./session-state-cleanup.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await cleanupTrackedSessionState(tempDirs.dirs, cleanup);
  }),
);
registerAgentSessionLoopTestLifecycle();

const text = (value: string) => ({ type: "text" as const, text: value });
const lookupCall = (id: string, args: Record<string, string>) => ({
  type: "toolCall" as const,
  id,
  name: "lookup",
  arguments: args,
});
const clientTools = (
  name: string,
  parameters: Parameters<typeof toClientToolDefinitions>[0][number]["function"]["parameters"],
  recorder: Parameters<typeof toClientToolDefinitions>[1],
) => toClientToolDefinitions([{ type: "function", function: { name, parameters } }], recorder);
const result = (value: string, details: Record<string, unknown>) => ({
  content: [text(value)],
  details,
});

it.for([
  { owner: "adapter", abortBeforeLaunch: false },
  { owner: "source", abortBeforeLaunch: false },
  { owner: "adapter", abortBeforeLaunch: true },
  { owner: "source", abortBeforeLaunch: true },
  { owner: "client", abortBeforeLaunch: true },
])(
  "settles the real $owner preparer with abortBeforeLaunch=$abortBeforeLaunch",
  { timeout: 10_000 },
  async ({ owner, abortBeforeLaunch }, { signal }) => {
    const directory = tempDirs.make("openclaw-adapter-lifecycle-");
    const output = path.join(directory, "receipt.txt");
    const args = { value: "local receipt" };
    const partial = result("writing receipt", {});
    const order: string[] = [];
    const updates: unknown[] = [];
    const outcomes: unknown[] = [];
    const recorder = {
      reserve: vi.fn(() => order.push("reserve")),
      complete: vi.fn(() => order.push("complete")),
      discard: vi.fn(() => order.push("discard")),
    };
    const tool = {
      name: "receipt",
      label: "Receipt",
      description: "Write a local receipt.",
      parameters: Type.Object({ value: Type.String() }),
      async execute(_id, input, _signal, onUpdate) {
        order.push("implementation");
        onUpdate?.(partial);
        await fs.writeFile(output, JSON.stringify(input));
        return result(await fs.readFile(output, "utf8"), { written: true });
      },
    } satisfies AgentTool;
    const definitions =
      owner === "client"
        ? clientTools(tool.name, { ...tool.parameters }, recorder)
        : toToolDefinitions([owner === "source" ? wrapToolWithBeforeToolCallHook(tool) : tool]);
    const definition = expectDefined(definitions[0], "receipt definition");
    const prepare = expectDefined(
      getInternalToolExecutionPreparer(definition),
      "real receipt preparer",
    );
    let cancelAtReady = () => {};
    // Observe the real preparer's returned handle; never substitute its launch/disposal work.
    attachInternalToolExecutionPreparer(definition, async (params) => {
      const prepared = await prepare(params);
      order.push(prepared.kind);
      if (prepared.kind === "ready" && abortBeforeLaunch) {
        cancelAtReady();
      }
      return {
        ...prepared,
        dispose() {
          order.push("dispose");
          prepared.dispose();
        },
      };
    });
    mockExchange([{ type: "toolCall", id: "receipt-call", name: "receipt", arguments: args }]);
    const { session } = await createTestSession({ customTools: definitions });
    cancelAtReady = () => session.agent.abort(new Error("cancelled after preparation"));
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "tool_execution_start") {
        order.push("start");
      } else if (event.type === "tool_execution_update") {
        order.push("update");
        updates.push(event.partialResult);
      } else if (event.type === "tool_execution_end") {
        order.push("end");
        outcomes.push(event);
      } else if (event.type === "message_end" && event.message.role === "toolResult") {
        order.push("result");
      } else if (event.type === "agent_end" || event.type === "agent_settled") {
        order.push(event.type);
      }
    });
    const prompt = session.prompt("Write one receipt.");
    try {
      await withinTest(prompt, signal);
      expect([session.isStreaming, session.agent.state.pendingToolCalls.size]).toEqual([false, 0]);
      if (abortBeforeLaunch) {
        expect(recorder.complete).not.toHaveBeenCalled();
        expect(updates).toEqual([]);
        await expect(fs.stat(output)).rejects.toMatchObject({ code: "ENOENT" });
        if (owner === "client") {
          expect(recorder.reserve).toHaveBeenCalledExactlyOnceWith("receipt-call", "receipt");
          expect(recorder.discard).toHaveBeenCalledExactlyOnceWith("receipt-call", "receipt");
        }
      } else {
        expect(updates).toEqual([partial]);
        expect(await fs.readFile(output, "utf8")).toBe(JSON.stringify(args));
        expect(streamMocks.streamSimple.mock.calls[1]?.[1].messages).toContainEqual(
          expect.objectContaining({
            role: "toolResult",
            toolCallId: "receipt-call",
            content: [text(JSON.stringify(args))],
          }),
        );
      }
      expect(outcomes).toMatchObject([
        {
          toolCallId: "receipt-call",
          isError: abortBeforeLaunch,
          executionStarted: !abortBeforeLaunch,
          ...(!abortBeforeLaunch
            ? { result: result(JSON.stringify(args), { written: true }) }
            : {}),
        },
      ]);
      const lifecycle = abortBeforeLaunch
        ? "start ready dispose end result agent_end agent_settled"
        : "start ready implementation update dispose end result agent_end agent_settled";
      expect(order.filter((step) => step !== "reserve" && step !== "discard")).toEqual(
        lifecycle.split(" "),
      );
    } finally {
      session.agent.abort();
      try {
        await withinTest(Promise.allSettled([prompt, session.agent.waitForIdle()]), signal);
      } finally {
        unsubscribe();
      }
    }
  },
);

it.each(["value", "apiKey", "account"])(
  "preserves %s arguments, correlation IDs and delivery facts through persistence",
  async (field) => {
    const client = field !== "value";
    const dir = tempDirs.make("openclaw-runtime-projection-");
    const scope = sessionScope(path.join(dir, "sessions.json"), "runtime-projection");
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    const sessionManager = SessionManager.open(scope, dir);
    guardSessionManager(sessionManager, { config: {}, allowedToolNames: ["lookup"] });
    const calls = vi.fn();
    const ids = client
      ? ["call_0", "call_1"]
      : ["call_lookup|fc-jztpgrWaMLTnokJk", "call_lookup|fc-jztDifferentokJk"];
    const values = client ? ["alpha", "beta"] : ids;
    const lookupCalls = values.map((value, index) => lookupCall(ids[index]!, { [field]: value }));
    const parameters = Type.Object({ value: Type.String() });
    const lookup: ToolDefinition<typeof parameters> = {
      name: "lookup",
      label: "Lookup",
      description: "Look up a record.",
      parameters,
      async execute(_id, args) {
        return result(args.value, args);
      },
    };
    const customTools = client
      ? clientTools(
          "lookup",
          {
            type: "object",
            properties: { [field]: { type: "string", enum: values } },
            required: [field],
            additionalProperties: false,
          },
          calls,
        )
      : [lookup];
    mockExchange([...(client ? [text("Looking up both records.")] : []), ...lookupCalls]);
    const extendReply = async (event: unknown) => {
      const { message } = event as MessageEndEvent;
      if (message.role !== "assistant") {
        return undefined;
      }
      return {
        message: {
          ...message,
          content: message.content.map((block) =>
            block.type === "text" ? text(`[[reply_to_current]] Extension: ${block.text}`) : block,
          ),
        },
      };
    };
    const { session } = await createTestSession({
      sessionManager,
      customTools,
      extension: client ? (api) => api.on("message_end", extendReply) : undefined,
    });
    const started: string[] = [];
    session.subscribe((event) => {
      if (event.type === "tool_execution_start") {
        started.push(event.toolCallId);
      }
    });
    await session.prompt(client ? "Look up alpha and beta." : "Look up both records.");
    expect(streamMocks.streamSimple).toHaveBeenCalledTimes(client ? 1 : 2);
    const stored = SessionManager.open(scope, dir)
      .getBranch()
      .flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
    const results = ids.map((toolCallId, index) => ({
      toolCallId,
      isError: false,
      ...(client
        ? { toolName: "lookup", details: { status: "pending" } }
        : result(values[index]!, { value: values[index] })),
    }));
    const resultHistory = client ? session.state.messages : stored;
    expect(resultHistory.filter((message) => message.role === "toolResult")).toMatchObject(results);
    if (client) {
      expect(calls.mock.calls).toEqual(values.map((value) => ["lookup", { [field]: value }]));
      expect([session.isStreaming, session.agent.state.pendingToolCalls.size]).toEqual([false, 0]);
    } else {
      expect(started).toEqual(ids);
    }
    const expected = {
      content: [
        ...(client ? [text("Extension: Looking up both records.")] : []),
        ...values.map((value, index) => lookupCall(ids[index]!, { [field]: value })),
      ],
      ...(client ? { openclawDelivery: { replyToCurrent: true } } : {}),
    };
    for (const history of client ? [session.state.messages, stored] : [stored]) {
      expect(history.find((message) => message.role === "assistant")).toMatchObject(expected);
    }
  },
);
