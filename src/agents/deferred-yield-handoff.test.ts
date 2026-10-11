import { expectDefined } from "@openclaw/normalization-core";
import { Type } from "typebox";
import { expect, it, vi } from "vitest";
import { runAgentLoop } from "../../packages/agent-core/src/agent-loop.js";
import type { StreamFn } from "../../packages/agent-core/src/types.js";
import { createDeferred } from "../../test/helpers/promise.js";
import type { AssistantMessage, Message } from "../llm/types.js";
import { createAssistantMessageEventStream } from "../llm/utils/event-stream.js";
import { toToolDefinitions } from "./agent-tool-definition-adapter.js";
import { wrapToolWithAbortSignal } from "./agent-tools.abort.js";
import { wrapToolWithBeforeToolCallHook } from "./agent-tools.before-tool-call.js";
import { createToolLoopBatchAdmission } from "./embedded-agent-runner/run/tool-loop-recovery.js";
import {
  attachInternalToolExecutionPreparer,
  getInternalToolExecutionPreparer,
} from "./runtime/internal-hooks.js";
import {
  wrapToolDefinition,
  createToolDefinitionFromAgentTool,
} from "./sessions/tools/tool-definition-wrapper.js";
import { createZeroUsageFixture } from "./test-helpers/usage-fixtures.js";
import {
  createToolSearchCatalogRef,
  createToolSearchTools,
  registerHeadlessToolSearchCatalog,
} from "./tool-search.js";
import { jsonResult, type AnyAgentTool } from "./tools/common.js";
import { createSessionsYieldTool } from "./tools/sessions-yield-tool.js";
const validArgs = {};

function deferredFixture(
  reason: unknown = { code: "sessions_yield", turnHandoff: true },
  declaredSequential = false,
) {
  const abort = new AbortController();
  const target = createSessionsYieldTool({
    sessionId: "yielding-session",
    claimYield: () => true,
    onYield: () => {
      abort.abort(reason);
    },
  });
  const execute = vi.spyOn(target, "execute");
  const ordinary = {
    name: "lookup",
    label: "lookup",
    description: "lookup",
    parameters: Type.Object({}),
    execute: vi.fn(async () => jsonResult({ status: "ok" })),
  };
  const catalogRef = createToolSearchCatalogRef();
  // Native session definition adapters preserve creator identity without prompt catalog metadata.
  const definition = createToolDefinitionFromAgentTool(target);
  // ToolDefinition's existing execution contract may declare an adapted target sequential.
  // The default sessions_yield creator stays nonsequential for async-result collection.
  if (declaredSequential) {
    definition.executionMode = "sequential";
  }
  const registeredTarget = wrapToolDefinition(definition);
  registerHeadlessToolSearchCatalog({ catalogRef, tools: [registeredTarget, ordinary] });
  const dispatcher = expectDefined(
    createToolSearchTools({ catalogRef, abortSignal: abort.signal }).find(
      (tool) => tool.name === "tool_call",
    ),
    "native dispatcher",
  );
  return { abort, execute, dispatcher, target, ordinary };
}

async function runDeferredBatch(
  f: ReturnType<typeof deferredFixture>,
  enabled: boolean,
  targetId: string,
  exec: AnyAgentTool["execute"],
) {
  const hook = {
    agentId: "main",
    sessionKey: `handoff:${enabled}`,
    sessionId: "session",
    runId: `handoff:${enabled}`,
    loopDetection: { enabled },
  };
  const dispatcher = wrapToolWithAbortSignal(
    wrapToolWithBeforeToolCallHook(f.dispatcher, hook),
    f.abort.signal,
  );
  const tools: AnyAgentTool[] = [
    dispatcher,
    {
      name: "exec",
      label: "exec",
      description: "exec",
      parameters: Type.Object({}),
      execute: exec,
    },
  ];
  let requests = 0;
  const streamFn: StreamFn = () => {
    const first = requests++ === 0;
    const stream = createAssistantMessageEventStream();
    const message: AssistantMessage = {
      role: "assistant",
      content: first
        ? [
            {
              type: "toolCall",
              id: "question",
              name: "tool_call",
              arguments: { id: targetId, args: validArgs },
            },
            { type: "toolCall", id: "effect", name: "exec", arguments: {} },
          ]
        : [],
      api: "faux",
      provider: "faux",
      model: "faux",
      usage: createZeroUsageFixture(),
      stopReason: first ? "toolUse" : "stop",
      timestamp: 1,
    };
    queueMicrotask(() => {
      stream.push({ type: "done", reason: first ? "toolUse" : "stop", message });
      stream.end();
    });
    return stream;
  };
  return await runAgentLoop(
    [{ role: "user", content: "ask first", timestamp: 0 }],
    {
      systemPrompt: "",
      messages: [],
      tools: toToolDefinitions(tools, hook, f.abort.signal).map((definition) =>
        wrapToolDefinition(definition),
      ),
    },
    {
      model: {
        id: "faux",
        name: "faux",
        api: "faux",
        provider: "faux",
        baseUrl: "https://example.test",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1000,
        maxTokens: 1000,
      },
      convertToLlm: (entries) => entries as Message[],
      beforeToolBatch: createToolLoopBatchAdmission(hook),
    },
    () => {},
    f.abort.signal,
    streamFn,
  );
}

it.each([false, true])(
  "honors declared sequential deferred targets before direct effects with loop detection %s",
  async (enabled) => {
    const f = deferredFixture(undefined, true);
    const exec = vi.fn(async () => jsonResult({ status: "executed" }));
    const messages = await runDeferredBatch(f, enabled, "sessions_yield", exec);
    expect(f.execute).toHaveBeenCalledOnce();
    expect(exec).not.toHaveBeenCalled();
    expect(
      messages.find(
        (message) => message.role === "toolResult" && message.toolCallId === "question",
      ),
    ).toMatchObject({ isError: false, details: { result: { details: { status: "yielded" } } } });
  },
);

it("keeps ordinary deferred targets parallel so later direct work can complete them", async () => {
  const f = deferredFixture();
  const release = createDeferred();
  f.ordinary.execute.mockImplementation(async () => {
    await release.promise;
    return jsonResult({ status: "ok" });
  });
  const exec = vi.fn(async () => {
    release.resolve();
    return jsonResult({ status: "executed" });
  });
  try {
    const messages = await runDeferredBatch(f, false, "lookup", exec);
    expect(exec).toHaveBeenCalledOnce();
    expect(f.ordinary.execute).toHaveBeenCalledOnce();
    expect(
      messages.find(
        (message) => message.role === "toolResult" && message.toolCallId === "question",
      ),
    ).toMatchObject({ isError: false, details: { result: { details: { status: "ok" } } } });
  } finally {
    release.resolve();
  }
});

it("rejects a same-name unregistered handoff lookalike and a per-call forged handoff", async () => {
  const f = deferredFixture();
  const lookalike = wrapToolWithAbortSignal(
    {
      name: "sessions_yield",
      label: "ask",
      description: "ask",
      parameters: Type.Object({}),
      execute: async () => {
        f.abort.abort({ code: "sessions_yield", turnHandoff: true });
        return jsonResult({ status: "yielded" });
      },
    },
    f.abort.signal,
  );
  await expect(lookalike.execute("fake", {})).rejects.toMatchObject({ name: "AbortError" });
  const fresh = deferredFixture();
  const callAbort = new AbortController();
  const pending = new Promise<never>(() => {});
  fresh.target.execute = () => pending;
  const dispatcher = wrapToolWithAbortSignal(fresh.dispatcher, fresh.abort.signal);
  const result = dispatcher.execute("forged", { id: "sessions_yield", args: {} }, callAbort.signal);
  callAbort.abort({ code: "sessions_yield", turnHandoff: true });
  await expect(result).rejects.toMatchObject({ name: "AbortError" });
  expect(fresh.abort.signal.aborted).toBe(false);
});

it.each(["execute", "prepared"] as const)(
  "preserves actual nested creator handoff through %s adapter",
  async (mode) => {
    const f = deferredFixture();
    const args = { id: "sessions_yield", args: validArgs };
    if (mode === "prepared") {
      attachInternalToolExecutionPreparer(f.dispatcher, async (params) => ({
        kind: "ready",
        args: params.args,
        execute: () => f.dispatcher.execute(params.toolCallId, params.args, params.signal),
        dispose() {},
      }));
    }
    const source = wrapToolWithAbortSignal(f.dispatcher, f.abort.signal);
    const definition = expectDefined(
      toToolDefinitions([source], undefined, f.abort.signal)[0],
      "native definition",
    );
    const wrapped = wrapToolDefinition(
      createToolDefinitionFromAgentTool(wrapToolDefinition(definition)),
    );
    const result =
      mode === "execute"
        ? await wrapped.execute(`nested:${mode}`, args)
        : await (async () => {
            const prepare = expectDefined(
              getInternalToolExecutionPreparer(wrapped),
              "native preparer",
            );
            const prepared = await prepare({
              toolCallId: `nested:${mode}`,
              args,
            });
            if (prepared.kind !== "ready") {
              throw new Error("Expected ready native invocation");
            }
            try {
              return await prepared.execute();
            } finally {
              prepared.dispose();
            }
          })();
    expect(result).toMatchObject({ details: { result: { details: { status: "yielded" } } } });
    expect(f.abort.signal.aborted).toBe(true);
    expect(f.execute).toHaveBeenCalledOnce();
  },
);

it("retains ordinary cancellation for an actual nested yield creator", async () => {
  const f = deferredFixture(new Error("Ordinary run cancellation"));
  const dispatcher = wrapToolWithAbortSignal(f.dispatcher, f.abort.signal);
  await expect(
    dispatcher.execute("cancelled", { id: "sessions_yield", args: validArgs }),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(f.execute).toHaveBeenCalledOnce();
});
