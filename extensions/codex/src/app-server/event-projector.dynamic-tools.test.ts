import { createContractToolTerminalObserver } from "openclaw/plugin-sdk/agent-runtime-test-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { readSessionTranscriptEvents } from "openclaw/plugin-sdk/session-transcript-runtime";
import { Type } from "typebox";
import {
  handleDynamicToolCallWithTimeout,
  toCodexDynamicToolProtocolResponse,
} from "./dynamic-tool-execution.js";
import { recordCodexDynamicToolResult } from "./dynamic-tool-result-projection.js";
import { createCodexDynamicToolBridge } from "./dynamic-tools.js";
import {
  createConfiguredProjection,
  createProjection,
  projectionEvents,
} from "./event-projector-projection.test-support.js";
import {
  describe,
  registerCodexEventProjectorTestLifecycle,
  expect,
  it,
  vi,
  createCodexTestToolTerminalObserver,
  createParams,
  createProjector,
  mockCallArg,
  forCurrentTurn,
  turnCompleted,
} from "./event-projector.test-harness.js";

registerCodexEventProjectorTestLifecycle();

type Projector = Awaited<ReturnType<typeof createProjector>>;
function recordBrowser(projector: Projector) {
  projector.recordDynamicToolCall({
    callId: "call-browser-1",
    tool: "browser",
    arguments: { action: "open", url: "http://127.0.0.1:3000" },
  });
  projector.recordDynamicToolResult({
    callId: "call-browser-1",
    tool: "browser",
    success: true,
    contentItems: [{ type: "inputText", text: "opened" }],
  });
}

async function discoverTools(
  projector: Projector,
  tools: unknown[],
  call: Record<string, unknown> = {},
  namespace: Record<string, unknown> = {},
) {
  const events = projectionEvents(projector);
  for (const item of [
    { type: "tool_search_call", arguments: { query: "web search" }, ...call },
    {
      type: "tool_search_output",
      status: "completed",
      tools: [{ type: "namespace", name: "openclaw", tools, ...namespace }],
    },
  ]) {
    await events.raw({ call_id: "search-call-1", execution: "client", ...item });
  }
}

function settleSearch(projector: Projector, namespace: string) {
  projector.recordDynamicToolCall({ callId: "dynamic-call-1", namespace, tool: "web_search" });
  projector.recordDynamicToolResult({
    callId: "dynamic-call-1",
    tool: "web_search",
    success: true,
    contentItems: [{ type: "inputText", text: "synthetic result" }],
  });
}

async function discoveryProjector() {
  vi.stubEnv("OPENCLAW_BUILD_PRIVATE_QA", "1");
  const recordEvent = vi.fn();
  return {
    recordEvent,
    ...(await createProjection(undefined, {
      trajectoryRecorder: { recordEvent, flush: async () => undefined },
    })),
  };
}

describe("CodexAppServerEventProjector dynamic tool projection", () => {
  it.each([false, true])(
    "preserves replay safety through dynamic tool settlement (async: %s)",
    async (asyncStarted) => {
      const params = await createParams();
      params.observeToolTerminal = createContractToolTerminalObserver(params.runId);
      const { projector, events } = await createProjection(params);
      const bridge = createCodexDynamicToolBridge({
        tools: [
          {
            name: "web_search",
            label: "Search",
            description: "Search synthetic results",
            parameters: Type.Object({ query: Type.String() }),
            execute: async () => ({
              content: [{ type: "text", text: "Search accepted." }],
              details: asyncStarted ? { async: true, status: "started", taskId: "task-1" } : {},
            }),
          },
        ],
        signal: new AbortController().signal,
        hookContext: { runId: params.runId },
      });
      const call = {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-search",
        tool: "web_search",
        arguments: { query: "synthetic query" },
      };
      projector.recordDynamicToolCall(call);

      const response = await handleDynamicToolCallWithTimeout({
        call,
        toolBridge: bridge,
        signal: new AbortController().signal,
        timeoutMs: 1_000,
        observeToolTerminal: params.observeToolTerminal,
      });
      const protocolResponse = toCodexDynamicToolProtocolResponse(response);
      recordCodexDynamicToolResult(projector, call, response, protocolResponse);

      expect(protocolResponse).toEqual({
        contentItems: [{ type: "inputText", text: "Search accepted." }],
        success: true,
      });
      expect(events.result(bridge.telemetry).replayMetadata).toEqual({
        hadPotentialSideEffects: asyncStarted,
        replaySafe: !asyncStarted,
      });
    },
  );

  it("records dynamic OpenClaw tool calls in mirrored transcript snapshots", async () => {
    const { projector, events } = await createProjection(undefined, {
      resolveDynamicToolResultContentSource: (toolName) =>
        toolName === "browser" ? "network" : undefined,
    });

    recordBrowser(projector);
    await events.delta("done");

    const result = events.result();

    expect(result.toolMetas).toEqual([{ toolName: "browser", isError: false }]);
    expect(result.messagesSnapshot[1]).toHaveProperty("content.0", {
      type: "toolCall",
      id: "call-browser-1",
      name: "browser",
      arguments: { action: "open", url: "http://127.0.0.1:3000" },
    });
    expect(result.messagesSnapshot).toMatchObject([
      { role: "user" },
      { role: "assistant" },
      {
        role: "toolResult",
        toolCallId: "call-browser-1",
        toolName: "browser",
        isError: false,
        content: [{ type: "text", text: "opened" }],
        __openclaw: { resultContentSource: "network" },
      },
      { role: "assistant", __openclaw: { turnTainted: true } },
    ]);
  });

  it("records bounded searchable discovery evidence without changing transcript bytes", async () => {
    const { projector, events, recordEvent } = await discoveryProjector();
    const searchedTools = [
      {
        type: "function",
        name: "web_search",
        description: "private-description-marker",
        parameters: { type: "object", properties: { secret: { const: "private-schema-marker" } } },
      },
      ...Array.from({ length: 40 }, (_value, index) => ({
        type: "function",
        name: `result_${index}`,
      })),
    ];

    await discoverTools(
      projector,
      searchedTools,
      { arguments: { query: "private-query-marker" } },
      { description: "private-namespace-marker" },
    );
    settleSearch(projector, "openclaw");

    const evidenceCall = recordEvent.mock.calls.find(([type]) => type === "tool.search.discovery");
    expect(evidenceCall?.[1]).toEqual({
      threadId: "thread-1",
      turnId: "turn-1",
      search: {
        callId: "search-call-1",
        callExecution: "client",
        outputExecution: "client",
        outputStatus: "completed",
        tools: [
          { namespace: "openclaw", name: "web_search" },
          ...Array.from({ length: 31 }, (_value, index) => ({
            namespace: "openclaw",
            name: `result_${index}`,
          })),
        ],
        truncated: true,
      },
      target: {
        callId: "dynamic-call-1",
        namespace: "openclaw",
        name: "web_search",
        success: true,
      },
    });
    const recordedEvidence = JSON.stringify(recordEvent.mock.calls);
    expect(recordedEvidence).not.toContain("private-");
    expect(JSON.stringify(events.result().messagesSnapshot)).not.toContain("tool_search");
  });

  it.each(["", "other"])("does not credit discovery in namespace=%s", async (namespace) => {
    const { projector, events, recordEvent } = await discoveryProjector();

    await discoverTools(projector, [{ type: "function", name: "web_search" }], {
      status: "completed",
    });
    settleSearch(projector, namespace);

    expect(recordEvent).not.toHaveBeenCalledWith("tool.search.discovery", expect.anything());
    expect(events.result().messagesSnapshot.slice(1, 3)).toMatchObject([
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "dynamic-call-1", name: "web_search" }],
      },
      {
        role: "toolResult",
        toolCallId: "dynamic-call-1",
        toolName: "web_search",
        isError: false,
        content: [{ type: "text", text: "synthetic result" }],
      },
    ]);
  });

  it.each(
    ["item", "turn"].flatMap((source) => [false, true].map((closed) => ({ source, closed }))),
  )(
    "settles delayed $source preview results only before projection closed=$closed",
    async ({ source, closed }) => {
      const preview = createDeferred<unknown>();
      const prepareNativeMcpAppResultDetails = vi.fn(() => preview.promise);
      const onToolResult = vi.fn();
      const params = await createParams();
      const sessionTarget = {
        agentId: "main",
        sessionId: params.sessionId,
        sessionKey: "agent:main:preview",
        storePath: `${params.workspaceDir}/sessions.sqlite`,
      };
      await upsertSessionEntry({
        ...sessionTarget,
        entry: {
          sessionId: params.sessionId,
          updatedAt: Date.now(),
        },
      });
      const { projector, events } = await createProjection(
        { ...params, sessionTarget, verboseLevel: "full", onToolResult },
        { prepareNativeMcpAppResultDetails },
      );
      const item = {
        type: "mcpToolCall",
        id: "late-preview",
        status: "completed",
        server: "sample",
        tool: "show_options",
        arguments: { limit: 4 },
        appContext: { connectorId: "sample", resourceUri: "ui://sample/options.html" },
        result: { content: [{ type: "text", text: "Delayed preview result." }] },
      };
      const details = { mcpAppPreview: { view: { id: "late-preview-view" } } };
      const notification = projector.handleNotification(
        source === "item" ? forCurrentTurn("item/completed", { item }) : turnCompleted([item]),
      );
      try {
        await vi.waitFor(() => expect(prepareNativeMcpAppResultDetails).toHaveBeenCalledOnce());
        if (closed) {
          await projector.closeProjection();
        } else {
          // Admitted native results still settle after abort until finalization closes projection.
          projector.markAborted();
        }
        const transcriptBeforeRelease = await readSessionTranscriptEvents(sessionTarget);
        onToolResult.mockClear();
        preview.resolve(details);
        await notification;
        await projector.closeProjection();
        const transcript = await readSessionTranscriptEvents(sessionTarget);
        if (closed) {
          expect(onToolResult).not.toHaveBeenCalled();
          expect(transcript).toEqual(transcriptBeforeRelease);
        } else {
          expect(onToolResult).toHaveBeenCalledWith({
            text: expect.stringContaining("Delayed preview result."),
          });
          expect(transcript).toContainEqual(
            expect.objectContaining({
              message: expect.objectContaining({ role: "toolResult", details }),
            }),
          );
        }
        const mirroredPreview = expect.objectContaining({ role: "toolResult", details });
        const snapshot = events.result().messagesSnapshot;
        if (closed) {
          expect(snapshot).not.toContainEqual(mirroredPreview);
        } else {
          expect(snapshot).toContainEqual(mirroredPreview);
        }
      } finally {
        preview.resolve(details);
        await notification;
        await projector.closeProjection();
      }
    },
  );

  it("marks native web-search results and subsequent assistant output as tainted", async () => {
    const { events } = await createProjection();

    await events.completed({
      type: "webSearch",
      id: "search-observed",
      status: "completed",
      durationMs: 5,
      query: "hostile result",
    });
    await events.delta("summary");

    expect(events.result().messagesSnapshot.slice(2, 4)).toMatchObject([
      {
        role: "toolResult",
        toolName: "web_search",
        __openclaw: { resultContentSource: "network" },
      },
      { __openclaw: { turnTainted: true } },
    ]);
  });

  it("carries async-started dynamic tool metadata into attempt results", async () => {
    const { projector, events } = await createProjection();

    const call = {
      callId: "call-image-1",
      tool: "image_generate",
      arguments: { action: "generate", prompt: "lighthouse" },
    };
    const contentItems = [{ type: "inputText" as const, text: "Background task started." }];
    projector.recordDynamicToolCall(call);
    projector.recordDynamicToolResult({
      ...call,
      asyncStarted: true,
      success: true,
      sideEffectEvidence: true,
      contentItems,
    });
    await events.completed({
      type: "dynamicToolCall",
      ...call,
      id: call.callId,
      namespace: null,
      status: "completed",
      contentItems,
      success: true,
      durationMs: 10,
    });

    const result = events.result();

    expect(result.toolMetas).toEqual([
      { toolName: "image_generate", meta: "lighthouse", asyncStarted: true, isError: false },
    ]);
    expect(result.replayMetadata).toEqual({ hadPotentialSideEffects: true, replaySafe: false });
  });

  it("does not replay transcript summaries when only tool output is enabled", async () => {
    const onToolResult = vi.fn();
    const { projector } = await createConfiguredProjection({
      onToolResult,
      shouldEmitToolResult: () => false,
      shouldEmitToolOutput: () => true,
    });

    recordBrowser(projector);

    expect(onToolResult).toHaveBeenCalledTimes(1);
    const payload = mockCallArg(onToolResult, 0, 0, "onToolResult") as { text?: string };
    expect(payload.text).toContain("```txt\nopened\n```");
  });

  it("does not keep side-effect evidence for pre-execution dynamic tool errors", async () => {
    const observeToolTerminal = createCodexTestToolTerminalObserver();
    const { projector, events } = await createConfiguredProjection({ observeToolTerminal });

    const call = {
      callId: "call-unknown-message",
      tool: "message",
      arguments: { action: "send", text: "hello" },
    };
    projector.recordDynamicToolCall(call);
    projector.recordDynamicToolResult({
      ...call,
      terminalResolution: observeToolTerminal({
        toolCallId: call.callId,
        toolName: call.tool,
        arguments: call.arguments,
        executionStarted: false,
        outcome: "failure",
        failure: { error: "Unknown OpenClaw tool: message" },
      }),
      success: false,
      terminalType: "error",
      contentItems: [{ type: "inputText", text: "Unknown OpenClaw tool: message" }],
    });

    const result = events.result();

    expect(result.replayMetadata).toEqual({ hadPotentialSideEffects: false, replaySafe: true });
    expect(result.lastToolError).toMatchObject({ toolName: "message", mutatingAction: false });
  });
});
