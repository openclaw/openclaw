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
  describe,
  registerCodexEventProjectorTestLifecycle,
  expect,
  it,
  vi,
  createCodexTestToolTerminalObserver,
  createParams,
  createProjector,
  buildEmptyToolTelemetry,
  requireRecord,
  requireArray,
  mockCallArg,
  forCurrentTurn,
  agentMessageDelta,
  turnCompleted,
} from "./event-projector.test-harness.js";

registerCodexEventProjectorTestLifecycle();

describe("CodexAppServerEventProjector dynamic tool projection", () => {
  it.each([false, true])(
    "preserves replay safety through dynamic tool settlement (async: %s)",
    async (asyncStarted) => {
      const params = await createParams();
      params.observeToolTerminal = createContractToolTerminalObserver(params.runId);
      const projector = await createProjector(params);
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
      expect(projector.buildResult(bridge.telemetry).replayMetadata).toEqual({
        hadPotentialSideEffects: asyncStarted,
        replaySafe: !asyncStarted,
      });
    },
  );

  it("records dynamic OpenClaw tool calls in mirrored transcript snapshots", async () => {
    const projector = await createProjector(undefined, {
      resolveDynamicToolResultContentSource: (toolName) =>
        toolName === "browser" ? "network" : undefined,
    });

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
    await projector.handleNotification(agentMessageDelta("done"));

    const result = projector.buildResult(buildEmptyToolTelemetry());

    expect(result.toolMetas).toEqual([{ toolName: "browser", isError: false }]);
    expect(result.messagesSnapshot.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "assistant",
    ]);
    const assistant = requireRecord(result.messagesSnapshot[1], "assistant tool call message");
    expect(assistant.role).toBe("assistant");
    expect(requireArray(assistant.content, "assistant content")[0]).toEqual({
      type: "toolCall",
      id: "call-browser-1",
      name: "browser",
      arguments: { action: "open", url: "http://127.0.0.1:3000" },
    });
    const toolResultMessage = requireRecord(result.messagesSnapshot[2], "tool result message");
    expect(toolResultMessage).toMatchObject({
      role: "toolResult",
      toolCallId: "call-browser-1",
      toolName: "browser",
      isError: false,
      content: [{ type: "text", text: "opened" }],
      __openclaw: { resultContentSource: "network" },
    });
    expect(
      requireRecord(result.messagesSnapshot[3], "final assistant")["__openclaw"],
    ).toMatchObject({
      turnTainted: true,
    });
  });

  it("records bounded searchable discovery evidence without changing transcript bytes", async () => {
    vi.stubEnv("OPENCLAW_BUILD_PRIVATE_QA", "1");
    const recordEvent = vi.fn();
    const projector = await createProjector(undefined, {
      trajectoryRecorder: {
        recordEvent,
        flush: async () => undefined,
      },
    });
    const searchedTools = [
      {
        type: "function",
        name: "web_search",
        description: "private-description-marker",
        defer_loading: true,
        parameters: {
          type: "object",
          properties: { secret: { const: "private-schema-marker" } },
        },
      },
      ...Array.from({ length: 40 }, (_value, index) => ({
        type: "function",
        name: `search_result_${index.toString().padStart(2, "0")}`,
        description: `private-description-${index}`,
        defer_loading: true,
        parameters: { type: "object" },
      })),
    ];

    await projector.handleNotification(
      forCurrentTurn("rawResponseItem/completed", {
        item: {
          type: "tool_search_call",
          call_id: "search-call-1",
          execution: "client",
          arguments: { query: "private-query-marker" },
        },
      }),
    );
    await projector.handleNotification(
      forCurrentTurn("rawResponseItem/completed", {
        item: {
          type: "tool_search_output",
          call_id: "search-call-1",
          status: "completed",
          execution: "client",
          tools: [
            {
              type: "namespace",
              name: "openclaw",
              description: "private-namespace-marker",
              tools: searchedTools,
            },
          ],
        },
      }),
    );
    projector.recordDynamicToolCall({
      callId: "dynamic-call-1",
      namespace: "openclaw",
      tool: "web_search",
      arguments: { query: "release marker" },
    });
    projector.recordDynamicToolResult({
      callId: "dynamic-call-1",
      tool: "web_search",
      success: true,
      contentItems: [{ type: "inputText", text: "synthetic result" }],
    });

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
            name: `search_result_${index.toString().padStart(2, "0")}`,
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
    expect(recordedEvidence).not.toContain("private-query-marker");
    expect(recordedEvidence).not.toContain("private-description");
    expect(recordedEvidence).not.toContain("private-schema-marker");
    expect(recordedEvidence).not.toContain("private-namespace-marker");
    expect(
      JSON.stringify(projector.buildResult(buildEmptyToolTelemetry()).messagesSnapshot),
    ).not.toContain("tool_search");
  });

  it.each([
    { privateQa: true, namespace: "" },
    { privateQa: true, namespace: "other" },
  ])(
    "does not credit discovery with privateQa=$privateQa namespace=$namespace",
    async ({ privateQa, namespace }) => {
      vi.stubEnv("OPENCLAW_BUILD_PRIVATE_QA", privateQa ? "1" : "0");
      const recordEvent = vi.fn();
      const projector = await createProjector(undefined, {
        trajectoryRecorder: {
          recordEvent,
          flush: async () => undefined,
        },
      });

      await projector.handleNotification(
        forCurrentTurn("rawResponseItem/completed", {
          item: {
            type: "tool_search_call",
            call_id: "search-call-1",
            status: "completed",
            execution: "client",
            arguments: { query: "web search" },
          },
        }),
      );
      await projector.handleNotification(
        forCurrentTurn("rawResponseItem/completed", {
          item: {
            type: "tool_search_output",
            call_id: "search-call-1",
            status: "completed",
            execution: "client",
            tools: [
              {
                type: "namespace",
                name: "openclaw",
                tools: [{ type: "function", name: "web_search" }],
              },
            ],
          },
        }),
      );
      projector.recordDynamicToolCall({
        callId: "dynamic-call-1",
        namespace,
        tool: "web_search",
      });
      projector.recordDynamicToolResult({
        callId: "dynamic-call-1",
        tool: "web_search",
        success: true,
        contentItems: [{ type: "inputText", text: "synthetic result" }],
      });

      expect(recordEvent).not.toHaveBeenCalledWith("tool.search.discovery", expect.anything());
      const result = projector.buildResult(buildEmptyToolTelemetry());
      expect(result.messagesSnapshot[1]).toMatchObject({
        role: "assistant",
        content: [{ type: "toolCall", id: "dynamic-call-1", name: "web_search" }],
      });
      expect(result.messagesSnapshot[2]).toMatchObject({
        role: "toolResult",
        toolCallId: "dynamic-call-1",
        toolName: "web_search",
        isError: false,
        content: [{ type: "text", text: "synthetic result" }],
      });
    },
  );

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
          sessionFile: params.sessionFile,
          updatedAt: Date.now(),
        },
      });
      const projector = await createProjector(
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
        const snapshot = projector.buildResult(buildEmptyToolTelemetry()).messagesSnapshot;
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
    const projector = await createProjector();

    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: {
          type: "webSearch",
          id: "search-observed",
          status: "completed",
          durationMs: 5,
          query: "hostile result",
        },
      }),
    );
    await projector.handleNotification(agentMessageDelta("summary"));

    const result = projector.buildResult(buildEmptyToolTelemetry());
    const toolResult = requireRecord(result.messagesSnapshot[2], "native web-search result");
    expect(toolResult).toMatchObject({
      role: "toolResult",
      toolName: "web_search",
      __openclaw: { resultContentSource: "network" },
    });
    expect(
      requireRecord(result.messagesSnapshot[3], "final assistant")["__openclaw"],
    ).toMatchObject({
      turnTainted: true,
    });
  });

  it("carries async-started dynamic tool metadata into attempt results", async () => {
    const projector = await createProjector();

    projector.recordDynamicToolCall({
      callId: "call-image-1",
      tool: "image_generate",
      arguments: { action: "generate", prompt: "lighthouse" },
    });
    projector.recordDynamicToolResult({
      callId: "call-image-1",
      tool: "image_generate",
      asyncStarted: true,
      success: true,
      sideEffectEvidence: true,
      contentItems: [{ type: "inputText", text: "Background task started." }],
    });
    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: {
          type: "dynamicToolCall",
          id: "call-image-1",
          namespace: null,
          tool: "image_generate",
          arguments: { action: "generate", prompt: "lighthouse" },
          status: "completed",
          contentItems: [{ type: "inputText", text: "Background task started." }],
          success: true,
          durationMs: 10,
        },
      }),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());

    expect(result.toolMetas).toEqual([
      {
        toolName: "image_generate",
        meta: "lighthouse",
        asyncStarted: true,
        isError: false,
      },
    ]);
    expect(result.replayMetadata).toEqual({
      hadPotentialSideEffects: true,
      replaySafe: false,
    });
  });

  it("does not replay transcript summaries when only tool output is enabled", async () => {
    const onToolResult = vi.fn();
    const projector = await createProjector({
      ...(await createParams()),
      onToolResult,
      shouldEmitToolResult: () => false,
      shouldEmitToolOutput: () => true,
    });

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

    expect(onToolResult).toHaveBeenCalledTimes(1);
    const payload = mockCallArg(onToolResult, 0, 0, "onToolResult") as { text?: string };
    expect(payload.text).toContain("opened");
    expect(payload.text).toContain("```txt\nopened\n```");
  });

  it("does not keep side-effect evidence for pre-execution dynamic tool errors", async () => {
    const observeToolTerminal = createCodexTestToolTerminalObserver();
    const projector = await createProjector({ ...(await createParams()), observeToolTerminal });

    projector.recordDynamicToolCall({
      callId: "call-unknown-message",
      tool: "message",
      arguments: { action: "send", text: "hello" },
    });
    projector.recordDynamicToolResult({
      callId: "call-unknown-message",
      tool: "message",
      terminalResolution: observeToolTerminal({
        toolCallId: "call-unknown-message",
        toolName: "message",
        arguments: { action: "send", text: "hello" },
        executionStarted: false,
        outcome: "failure",
        failure: { error: "Unknown OpenClaw tool: message" },
      }),
      success: false,
      terminalType: "error",
      contentItems: [{ type: "inputText", text: "Unknown OpenClaw tool: message" }],
    });

    const result = projector.buildResult(buildEmptyToolTelemetry());

    expect(result.replayMetadata).toEqual({ hadPotentialSideEffects: false, replaySafe: true });
    expect(result.lastToolError).toMatchObject({
      toolName: "message",
      mutatingAction: false,
    });
  });
});
