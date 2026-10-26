import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentToolResult } from "openclaw/plugin-sdk/agent-core";
import { createOpenClawCodingTools, type AnyAgentTool } from "openclaw/plugin-sdk/agent-harness";
import {
  embeddedAgentLog,
  getPluginToolMeta,
  wrapToolWithBeforeToolCallHook,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  buildContractReplyPayloads,
  createContractToolTerminalObserver,
  createOwnerBackedContractTool,
} from "openclaw/plugin-sdk/agent-runtime-test-contracts";
import type { ChannelThreadingToolContext } from "openclaw/plugin-sdk/channel-contract";
import type { DecisionOutcome } from "openclaw/plugin-sdk/decisions";
import {
  onInternalDiagnosticEvent,
  waitForDiagnosticEventsDrained,
  type DiagnosticEventPayload,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { RemoteWorkspaceFileReader } from "openclaw/plugin-sdk/file-access-runtime";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "openclaw/plugin-sdk/hook-runtime";
import {
  createEmptyPluginRegistry,
  createMockPluginRegistry,
  createTestRegistry,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  captureRuntimeConfigAsyncReader,
  clearRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { estimateToolResultTextChars } from "openclaw/plugin-sdk/text-utility-runtime";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  handleDynamicToolCallWithTimeout,
  toCodexDynamicToolProtocolResponse,
} from "./dynamic-tool-execution.js";
import { filterCodexDynamicTools } from "./dynamic-tool-profile.js";
import {
  createCodexDynamicToolBridge,
  projectCodexExecutableDynamicTools,
} from "./dynamic-tools.js";
import {
  installResultMiddleware,
  flattenSpecsWithNamespace,
  mediaResult,
  textToolResult,
  throwingResultObserver,
  createBridge,
  createTool,
  callTool,
  createDynamicToolCall,
  type BridgeOptions,
} from "./dynamic-tools.test-support.js";
import {
  CODEX_OPENCLAW_DIRECT_DYNAMIC_TOOL_NAMESPACE,
  type CodexDynamicToolCallResponse,
  type CodexDynamicToolSpec,
  type JsonValue,
} from "./protocol.js";
import { codexDynamicToolsFingerprint } from "./thread-fingerprints.js";

const CODEX_OPENCLAW_DYNAMIC_TOOL_NAMESPACE = "openclaw";

const COMPUTER_FRAME_IMAGE =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
const REPLACEMENT_FRAME_IMAGE =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=";

function createScreenshotBridge() {
  const computerContextEpoch: {
    value: number;
    frameToolCallId?: string;
    frameImageIdentity?: string;
  } = { value: 0 };
  const bridge = createSingleToolBridge(
    createTool("computer", {
      execute: vi.fn(async (toolCallId: string) => {
        computerContextEpoch.frameToolCallId = toolCallId;
        computerContextEpoch.frameImageIdentity = frameImageIdentity(COMPUTER_FRAME_IMAGE);
        return { content: [frameImage(COMPUTER_FRAME_IMAGE)], details: {} };
      }),
    }),
    { computerContextEpoch },
  );

  return { bridge, computerContextEpoch };
}

const frameImage = (data: string) => ({ type: "image" as const, data, mimeType: "image/png" });

function holdResults() {
  const entered = createDeferred<void>();
  const release = createDeferred<void>();
  installResultMiddleware(async (event) => {
    entered.resolve();
    await release.promise;
    return { result: event.result };
  });
  return { entered, release };
}

function frameImageIdentity(data: string, mimeType = "image/png") {
  return createHash("sha256")
    .update(JSON.stringify([mimeType, data]))
    .digest("hex");
}

function createDecisionToolForBridge(workspaceDir: string): AnyAgentTool {
  const tool = createOpenClawCodingTools({
    agentId: "main",
    sessionKey: "agent:main:decisions",
    workspaceDir,
    config: {
      agents: { defaults: { decisionModel: "openai/gpt-6-luna" } },
      tools: { allow: ["decision_evaluate"] },
    },
    toolConstructionPlan: {
      includeBaseCodingTools: false,
      includeShellTools: false,
      includeChannelTools: false,
      includeOpenClawTools: true,
      includePluginTools: false,
    },
  }).find((entry) => entry.name === "decision_evaluate");
  if (!tool) {
    throw new Error("Configured decision_evaluate tool was not assembled");
  }
  return tool;
}

function createSingleToolBridge(tool: AnyAgentTool, options: BridgeOptions = {}) {
  return createBridge([tool], options);
}

function createBridgeWithToolResult(
  toolName: string,
  toolResult: AgentToolResult<unknown>,
  hookContext?: Parameters<typeof createCodexDynamicToolBridge>[0]["hookContext"],
) {
  return createSingleToolBridge(createTool(toolName, { execute: vi.fn(async () => toolResult) }), {
    hookContext,
  });
}

function mockToolBridge(
  name: string,
  result = textToolResult("done"),
  options: BridgeOptions = {},
) {
  const execute = vi.fn(async (_id: string, _args: unknown) => result);
  return { execute, bridge: createSingleToolBridge(createTool(name, { execute }), options) };
}

function firstInputText(response: CodexDynamicToolCallResponse) {
  const firstItem = response.contentItems[0];
  if (firstItem?.type !== "inputText" || typeof firstItem.text !== "string") {
    throw new Error("expected inputText tool result");
  }
  return firstItem.text;
}

const inputText = (text: string) => [{ type: "inputText" as const, text }];

function expectInputText(response: CodexDynamicToolCallResponse, text: string, success = true) {
  expect(toCodexDynamicToolProtocolResponse(response)).toEqual({
    success,
    contentItems: inputText(text),
  });
}

const requireRecord = createRequireRecord("object", "expected-label");
function callArg(
  mock: { mock: { calls: Array<Array<unknown>> } },
  callIndex: number,
  argIndex: number,
  label: string,
) {
  const call = mock.mock.calls.at(callIndex);
  if (!call) {
    throw new Error(`Expected ${label}`);
  }
  return call[argIndex];
}

function specNames(specs: readonly CodexDynamicToolSpec[]): string[] {
  return flattenSpecsWithNamespace(specs).map((tool) => tool.name);
}

function expectExecuteCall(
  execute: { mock: { calls: Array<Array<unknown>> } },
  expected: { callId: string; args: Record<string, unknown> },
) {
  expect([0, 1, 2, 3].map((index) => execute.mock.calls[0]?.[index])).toEqual([
    expected.callId,
    expected.args,
    expect.any(AbortSignal),
    undefined,
  ]);
}

async function handleMessageToolCall(
  bridge: ReturnType<typeof createCodexDynamicToolBridge>,
  arguments_: JsonValue,
) {
  return await callTool(bridge, "message", arguments_);
}

const STRICT_INSTRUCTION_SCHEMA = {
  type: "object",
  properties: { instruction: { type: "string" } },
  required: ["instruction"],
  additionalProperties: false,
} as const;

async function runSchemaToolCall(params: {
  arguments: JsonValue;
  callId: string;
  name?: string;
  direct?: boolean;
  parameters?: AnyAgentTool["parameters"];
  prepareArguments?: AnyAgentTool["prepareArguments"];
}) {
  const name = params.name ?? "strict_tool";
  const execute = vi.fn(async () => textToolResult("done"));
  const tool = createTool(name, {
    parameters: params.parameters ?? STRICT_INSTRUCTION_SCHEMA,
    prepareArguments: params.prepareArguments,
    execute,
  });
  const bridge = createSingleToolBridge(tool, {
    directToolNames: params.direct ? [name] : undefined,
  });
  const response = await bridge.handleToolCall({
    ...createDynamicToolCall(name, params.arguments, params.callId),
    namespace: params.direct ? CODEX_OPENCLAW_DIRECT_DYNAMIC_TOOL_NAMESPACE : null,
  });
  return { bridge, execute, response, tool };
}

function expectSchemaRejection(
  response: Awaited<ReturnType<typeof runSchemaToolCall>>["response"],
  execute: ReturnType<typeof vi.fn>,
  message: string,
) {
  expect(execute).not.toHaveBeenCalled();
  expect(response).toMatchObject({
    success: false,
    executionStarted: false,
    contentItems: inputText(expect.stringContaining(message)),
  });
}

afterEach(() => {
  resetGlobalHookRunner();
  setActivePluginRegistry(createEmptyPluginRegistry());
  clearRuntimeConfigSnapshot();
});

describe("createCodexDynamicToolBridge", () => {
  it.each(["direct", "searchable"] as const)(
    "preserves Decision outcomes through the %s tool surface",
    async (loading) => {
      const outcomes: DecisionOutcome[] = [
        {
          status: "ok",
          result: {
            model: "gpt-6-luna",
            answers: {
              incident: { type: "boolean", probabilityTrue: 0.95 },
              route: {
                type: "choice",
                choice: "support",
                probabilities: { support: 0.9, billing: 0.1 },
              },
              urgency: { type: "score", score: 1.75, probabilities: [0, 0.25, 0.75] },
            },
            usage: { inputTokens: 100, outputTokens: 0 },
          },
          provenance: { providerId: "openai", rubricVersion: "test", runtimeGeneration: "test" },
        },
        { status: "unavailable", reason: "credentials-unavailable" },
      ];
      await withOpenClawTestState(
        { layout: "split", prefix: "codex-decisions-" },
        async (state) => {
          const tool = createDecisionToolForBridge(state.workspaceDir);
          const tools = filterCodexDynamicTools([tool], {});
          expect(tools).toEqual([tool]);
          const createDecisionBridge = () => createBridge(tools, { loading });
          const batch = {
            state: { message: "Checkout is unavailable." },
            questions: {
              incident: { type: "boolean" },
              route: { type: "choice", criteria: { support: "Outages", billing: "Invoices" } },
              urgency: { type: "score", criteria: ["Routine", "Soon", "Immediate"] },
            },
          };
          for (const outcome of outcomes) {
            const execute = vi.fn<AnyAgentTool["execute"]>(async () =>
              textToolResult(JSON.stringify(outcome), outcome),
            );
            tool.execute = execute;
            const bridge = createDecisionBridge();
            expect(specNames(bridge.availableSpecs)).toContain("decision_evaluate");
            const response = await callTool(bridge, "decision_evaluate", batch);
            expect(response.success).toBe(outcome.status === "ok");
            expect(JSON.parse(firstInputText(response))).toEqual(outcome);
            expect(execute).toHaveBeenCalledOnce();
            expect(execute.mock.calls[0]?.[1]).toEqual(batch);
          }

          const started = createDeferred<AbortSignal>();
          const cancellation = new Error("Decision caller cancelled");
          tool.execute = vi.fn(async (_id, _args, signal) => {
            if (!signal) {
              throw new Error("Decision call requires a cancellation signal");
            }
            started.resolve(signal);
            await new Promise<never>((_resolve, reject) => {
              signal.addEventListener("abort", () => reject(cancellation), { once: true });
            });
            throw new Error("Cancelled Decision must not return a result");
          });
          const call = new AbortController();
          const pending = callTool(createDecisionBridge(), "decision_evaluate", batch, undefined, {
            signal: call.signal,
          });
          const signal = await started.promise;
          call.abort(cancellation);
          expect(signal.aborted).toBe(true);
          expect((await pending).success).toBe(false);
          expect(tool.execute).toHaveBeenCalledOnce();
        },
      );
    },
  );

  it("awaits execution policy before dispatch and refuses a stale policy", async () => {
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    const { execute, bridge } = mockToolBridge("synthetic", textToolResult("executed"), {
      assertCurrentAsync: async () => {
        entered.resolve();
        await release.promise;
        throw new Error("execution policy changed");
      },
    });
    const pending = callTool(bridge, "synthetic");
    await entered.promise;
    expect(execute).not.toHaveBeenCalled();
    release.resolve();
    expectSchemaRejection(await pending, execute, "execution policy changed");
  });

  it.each([
    { kind: "high-cardinality", message: "more violation(s) omitted", maxLength: 800 },
    { kind: "oversized detail", message: "[detail truncated]", maxLength: 260 },
  ])("bounds $kind validation errors returned to Codex", async ({ kind, message, maxLength }) => {
    const propertyNames = Array.from({ length: 10 }, (_, index) => `field${index}`);
    const manyFields = kind === "high-cardinality";
    const { execute, response } = await runSchemaToolCall({
      arguments: manyFields
        ? Object.fromEntries(propertyNames.map((name) => [name, 47]))
        : { [`unexpected_property_${"x".repeat(240)}`]: true },
      callId: "call-bounded-validation",
      name: "bounded_validation_tool",
      parameters: {
        type: "object",
        properties: manyFields
          ? Object.fromEntries(propertyNames.map((name) => [name, { type: "string" }]))
          : {},
        ...(manyFields ? { required: propertyNames } : {}),
        additionalProperties: false,
      },
    });

    expectSchemaRejection(response, execute, message);
    expect(firstInputText(response).length).toBeLessThanOrEqual(maxLength);
  });

  it("prepares raw null arguments before native Codex schema validation", async () => {
    const prepareArguments = vi.fn(function (this: AnyAgentTool, arguments_: unknown) {
      return arguments_ === null ? { preparedBy: this.name } : arguments_;
    });
    const { execute, response } = await runSchemaToolCall({
      arguments: null,
      callId: "call-null-compatibility",
      name: "optional_object_tool",
      parameters: {
        type: "object",
        properties: { preparedBy: { type: "string" } },
        additionalProperties: false,
      },
      prepareArguments,
      direct: true,
    });

    expect(prepareArguments).toHaveBeenCalledWith(null);
    expectInputText(response, "done");
    expectExecuteCall(execute, {
      callId: "call-null-compatibility",
      args: { preparedBy: "optional_object_tool" },
    });
  });

  it("leaves external MCP tool argument validation to the MCP bridge", async () => {
    const tool = createOwnerBackedContractTool({
      pluginId: "mcp-bridge",
      name: "external_mcp_tool",
      result: textToolResult("mcp handled"),
    });
    tool.parameters = STRICT_INSTRUCTION_SCHEMA;
    const meta = getPluginToolMeta(tool);
    expect(meta).toBeDefined();
    Object.assign(meta ?? {}, {
      mcp: {
        serverName: "external",
        safeServerName: "external",
        toolName: tool.name,
        operation: "tool",
      },
    });
    const bridge = createSingleToolBridge(tool);

    const response = await callTool(bridge, tool.name, { instruction: 47 }, "call-external-mcp");

    expectInputText(response, "mcp handled");
  });

  it("surfaces a rejected owner-backed memory write before a false final claim", async () => {
    const tool = createOwnerBackedContractTool({
      pluginId: "memory-lancedb",
      name: "memory_store",
      result: textToolResult("Memory storage is disabled in incognito mode.", {
        status: "blocked",
        error: "incognito mode",
      }),
    });
    const bridge = createSingleToolBridge(tool);
    const call = createDynamicToolCall(
      "memory_store",
      { text: "Tuesday 09:00 release window" },
      "call-memory-store",
    );

    const response = await handleDynamicToolCallWithTimeout({
      call,
      toolBridge: bridge,
      signal: new AbortController().signal,
      timeoutMs: 1_000,
      observeToolTerminal: createContractToolTerminalObserver("run-codex-memory"),
    });
    const payloads = buildContractReplyPayloads({
      assistantText: "Got it - I'll remember the Tuesday release window.",
      lastToolError: response.terminalResolution?.lastToolError,
    });

    expect(response.terminalResolution?.lastToolError).toMatchObject({ mutatingAction: true });
    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.text).toContain("I'll remember");
    expect(JSON.stringify(toCodexDynamicToolProtocolResponse(response))).not.toContain(
      "memory-lancedb",
    );
  });

  it("keeps model-visible tools stable when plugin discovery order changes", () => {
    const tools = [
      createTool("web_search"),
      createTool("computer", { catalogMode: "direct-only" }),
      createTool("agents_list"),
      createTool("openclaw"),
    ];
    const createOrderedBridge = (ordered: AnyAgentTool[]) =>
      createBridge(ordered, { registeredTools: ordered, directToolNames: ["openclaw"] });
    const forward = createOrderedBridge(tools);
    const reversed = createOrderedBridge(tools.toReversed());

    expect(forward.availableSpecs).toEqual(reversed.availableSpecs);
    expect(forward.specs).toEqual(reversed.specs);
    expect(codexDynamicToolsFingerprint(forward.specs)).toBe(
      codexDynamicToolsFingerprint(reversed.specs),
    );
    expect(specNames(forward.specs)).toEqual(["agents_list", "openclaw", "web_search", "computer"]);
    expect(forward.specs.filter((spec) => spec.type === "namespace")).toEqual([
      expect.objectContaining({
        name: CODEX_OPENCLAW_DYNAMIC_TOOL_NAMESPACE,
        tools: [expect.objectContaining({ name: "web_search", deferLoading: true })],
      }),
      expect.objectContaining({
        name: CODEX_OPENCLAW_DIRECT_DYNAMIC_TOOL_NAMESPACE,
        tools: [expect.objectContaining({ name: "computer" })],
      }),
    ]);
  });

  it("can register a durable tool schema while denying execution for the current turn", async () => {
    const unavailableToolName = "unavailable_task";
    const unavailableExecute = vi.fn(async () => textToolResult("unavailable tool recorded"));
    const onToolOutcome = vi.fn();
    const bridge = createSingleToolBridge(createTool("message"), {
      registeredTools: [
        createTool("message"),
        createTool(unavailableToolName, { execute: unavailableExecute }),
      ],
      hookContext: { runId: "run-unavailable", onToolOutcome },
    });

    expect(specNames(bridge.availableSpecs)).toEqual(["message"]);
    expect(bridge.availableTools.map((tool) => tool.name)).toEqual(["message"]);
    expect(specNames(bridge.specs)).toEqual(["message", unavailableToolName]);

    const result = await callTool(bridge, unavailableToolName);

    expectInputText(
      result,
      `OpenClaw tool is not available for this turn: ${unavailableToolName}`,
      false,
    );
    expect(result).toMatchObject({ executionStarted: false, executedArguments: {} });
    expect(unavailableExecute).not.toHaveBeenCalled();
    expect(onToolOutcome).toHaveBeenLastCalledWith({
      toolName: unavailableToolName,
      argsHash: "",
      resultHash: "",
      terminalPresentation: undefined,
      presentationOnly: true,
    });
  });

  it("publishes and executes a repaired schema with a literal prototype property", async () => {
    const args = { ["__proto__"]: "synthetic value" };
    const schema = {
      type: "object",
      properties: { ["__proto__"]: { type: "string", description: null } },
      required: ["__proto__"],
      additionalProperties: false,
    };
    const { bridge, execute, response } = await runSchemaToolCall({
      arguments: args,
      callId: "call-literal-schema-property",
      parameters: schema,
    });

    expect(flattenSpecsWithNamespace(bridge.specs)[0]?.inputSchema).toStrictEqual({
      ...schema,
      properties: { ["__proto__"]: { type: "string" } },
    });
    expectInputText(response, "done");
    expectExecuteCall(execute, { callId: "call-literal-schema-property", args });
  });

  it("quarantines dynamic tools with unsupported input schemas", async () => {
    vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
    const diagnosticEvents: DiagnosticEventPayload[] = [];
    const hookContext = {
      agentId: "agent-quarantine",
      runId: "run-1",
      sessionId: "session-1",
      sessionKey: "global",
    };
    const unsubscribeDiagnostics = onInternalDiagnosticEvent((event) =>
      diagnosticEvents.push(event),
    );
    const badExecute = vi.fn();
    const tools = [
      createTool("message"),
      createTool("fuzzplugin_move_angles", {
        parameters: { type: "array", items: { type: "number" } },
        execute: badExecute,
      }),
    ];
    let bridge!: ReturnType<typeof createCodexDynamicToolBridge>;
    try {
      bridge = createBridge(tools, { hookContext });
      await waitForDiagnosticEventsDrained();
    } finally {
      unsubscribeDiagnostics();
    }

    expect(specNames(bridge.availableSpecs)).toEqual(["message"]);
    expect(specNames(bridge.specs)).toEqual(["message"]);
    const projected = projectCodexExecutableDynamicTools({ tools });
    expect(projected.availableTools.map((tool) => tool.name)).toEqual(
      bridge.availableTools.map((tool) => tool.name),
    );
    expect(projected.availableTools.map((tool) => tool.name)).toEqual(["message"]);
    expect(bridge.telemetry.quarantinedTools).toEqual([
      {
        tool: "fuzzplugin_move_angles",
        violations: ['fuzzplugin_move_angles.inputSchema.type must be "object"'],
      },
    ]);
    expect(diagnosticEvents).toContainEqual(
      expect.objectContaining({
        type: "tool.execution.blocked",
        ...hookContext,
        toolName: "fuzzplugin_move_angles",
        deniedReason: "unsupported_tool_schema",
        reason: 'fuzzplugin_move_angles.inputSchema.type must be "object"',
      }),
    );

    const result = await callTool(bridge, "fuzzplugin_move_angles");

    expectInputText(result, "Unknown OpenClaw tool: fuzzplugin_move_angles", false);
    expect(result).toMatchObject({ executionStarted: false, executedArguments: {} });
    expect(badExecute).not.toHaveBeenCalled();
  });

  it.each([
    { name: "bad.name", placement: "direct", source: "both" },
    { name: " bad", placement: "searchable", source: "available" },
    { name: "   ", placement: "direct", source: "both" },
    { name: "a".repeat(129), placement: "direct-only", source: "registered" },
    { name: "mcp__read", placement: "searchable", source: "both" },
  ] as const)("quarantines Codex-invalid dynamic tool name $name", async (testCase) => {
    vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
    const execute = vi.fn(async () => textToolResult("healthy sibling executed"));
    const placement =
      testCase.placement === "direct-only" ? { catalogMode: "direct-only" as const } : {};
    const invalidTool = createTool(testCase.name, { ...placement });
    const sibling = createTool("valid_sibling", { execute, ...placement });
    const registeredOnly = createTool("registered_sibling", { ...placement });
    const tools = [sibling, ...(testCase.source === "registered" ? [] : [invalidTool])];
    const registeredTools = [
      sibling,
      registeredOnly,
      ...(testCase.source === "available" ? [] : [invalidTool]),
    ];
    const bridge = createBridge(tools, {
      registeredTools,
      ...(testCase.placement === "direct" ? { loading: "direct" as const } : {}),
    });
    expect(bridge.availableTools.map((tool) => tool.name)).toEqual(["valid_sibling"]);
    expect(specNames(bridge.availableSpecs)).toEqual(["valid_sibling"]);
    expect(specNames(bridge.specs).toSorted()).toEqual(["registered_sibling", "valid_sibling"]);
    expect(bridge.telemetry.quarantinedTools).toEqual([
      expect.objectContaining({ tool: testCase.name }),
    ]);
    const validResult = await callTool(bridge, "valid_sibling", {}, "call-valid");
    expect(validResult.success).toBe(true);
    expect(execute).toHaveBeenCalledOnce();

    const invalidResult = await callTool(bridge, testCase.name, {}, "call-invalid");
    expect(invalidResult).toMatchObject({ success: false, executionStarted: false });
    expectInputText(invalidResult, `Unknown OpenClaw tool: ${testCase.name}`, false);
  });

  it("preserves the canonical cap for tiny contexts", async () => {
    const bridge = createBridgeWithToolResult("large_lookup", textToolResult("x".repeat(70_000)), {
      contextWindowTokens: 1,
    });
    const result = await callTool(bridge, "large_lookup", {}, "call-context-cap");
    expect(firstInputText(result).length).toBe(1);
  });

  it("shares weighted budget across mixed text blocks while preserving images", async () => {
    const bridge = createBridgeWithToolResult(
      "mixed_lookup",
      {
        content: [
          { type: "text", text: "a".repeat(4_000) },
          frameImage(COMPUTER_FRAME_IMAGE),
          { type: "text", text: "你".repeat(9_000) },
        ],
        details: {},
      },
      { contextWindowTokens: 128_000 },
    );

    const result = await callTool(bridge, "mixed_lookup", {}, "call-mixed-weighted");
    const text = result.contentItems
      .map((item) => (item.type === "inputText" && typeof item.text === "string" ? item.text : ""))
      .join("");

    expect(result.contentItems.map((item) => item.type)).toEqual([
      "inputText",
      "inputImage",
      "inputText",
    ]);
    expect(result.contentItems[0]).toEqual({ type: "inputText", text: "a".repeat(4_000) });
    expect(estimateToolResultTextChars(text)).toBeLessThanOrEqual(32_000);
    expect(text).toContain("original 13000 chars, weighted budget 32000");
  });

  it.each([
    { tool: "tts", timedOut: false },
    { tool: "tts", timedOut: true },
    { tool: "sessions_spawn", timedOut: true },
  ])(
    "separates artifacts from committed $tool effects (timeout: $timedOut)",
    async ({ tool, timedOut }) => {
      const { entered, release } = holdResults();
      const result =
        tool === "tts"
          ? mediaResult("/tmp/reply.opus", true)
          : textToolResult("Accepted.", {
              status: "accepted",
              runId: "child-run",
              childSessionKey: "child-session",
              expectsCompletionMessage: true,
            });
      const outer = new AbortController();
      const bridge = createSingleToolBridge(
        createTool(tool, { execute: vi.fn(async () => result) }),
        { signal: outer.signal },
      );
      const handle = vi.spyOn(bridge, "handleToolCall");
      const onAgentToolResult = vi.fn();
      vi.useFakeTimers();
      try {
        const response = handleDynamicToolCallWithTimeout({
          call: createDynamicToolCall(tool, { text: "hello" }, "held-result"),
          toolBridge: bridge,
          signal: outer.signal,
          timeoutMs: 1,
          onAgentToolResult,
          observeToolTerminal: createContractToolTerminalObserver(`run-held-${tool}-${timedOut}`),
        });
        await entered.promise;
        if (timedOut) {
          await vi.advanceTimersByTimeAsync(1);
          expect(await response).toMatchObject({ success: false });
          expect(outer.signal.aborted).toBe(false);
        }
        release.resolve();
        // Drain the actual bridge continuation, not just the watchdog winner.
        await handle.mock.results[0]?.value;
        expect(await response).toMatchObject({ success: !timedOut });
        expect(onAgentToolResult).toHaveBeenCalledOnce();
        if (tool === "tts") {
          expect(bridge.telemetry.toolMediaUrls).toEqual(timedOut ? [] : ["/tmp/reply.opus"]);
          expect(bridge.telemetry.toolAudioAsVoice).toBe(!timedOut);
        } else {
          expect(bridge.telemetry.acceptedSessionSpawns).toEqual([
            {
              runId: "child-run",
              childSessionKey: "child-session",
              expectsCompletionMessage: true,
            },
          ]);
        }
      } finally {
        release.resolve();
        await Promise.allSettled(handle.mock.results.map((entry) => entry.value));
        handle.mockRestore();
        vi.useRealTimers();
      }
    },
  );

  it.each([
    { name: "tts", pluginId: "tts-collision", trusted: false, mediaUrl: "/tmp/plugin.opus" },
    {
      name: "dir_fetch",
      pluginId: "file-transfer",
      trusted: true,
      mediaUrl: "/tmp/plugin-file.txt",
    },
  ])(
    "binds local media trust to the concrete $name plugin",
    async ({ name, pluginId, trusted, mediaUrl }) => {
      const tool = createOwnerBackedContractTool({
        pluginId,
        name,
        ...(trusted ? { trustedLocalMedia: true } : {}),
        result: trusted
          ? mediaResult(mediaUrl)
          : {
              content: [{ type: "text", text: "plugin audio" }],
              details: { media: { mediaUrl, audioAsVoice: true, trustedLocalMedia: true } },
            },
      });
      const bridge = createSingleToolBridge(tool);

      await callTool(bridge, name, trusted ? {} : { text: "hello" });

      expect(bridge.telemetry.toolMediaUrls).toEqual(trusted ? [mediaUrl] : []);
      if (!trusted) {
        expect(bridge.telemetry.toolAutoDeliveryMediaUrls).toEqual([]);
      }
    },
  );

  it("records the current provider and transport thread for implicit message sends", async () => {
    const hasRepliedRef = { value: false };
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "slack",
          plugin: {
            id: "slack",
            messaging: { normalizeTarget: (raw: string) => raw.trim().toLowerCase() },
            threading: {
              resolveAutoThreadId: ({
                to,
                toolContext,
              }: {
                to: string;
                toolContext?: ChannelThreadingToolContext;
              }) =>
                (to === toolContext?.currentMessagingTarget ||
                  to === toolContext?.currentChannelId) &&
                (toolContext?.replyToMode === "first" || toolContext?.replyToMode === "batched") &&
                !toolContext.hasRepliedRef?.value
                  ? toolContext.currentThreadTs
                  : undefined,
            },
          },
          source: "test",
        },
      ]),
    );
    const bridge = createSingleToolBridge(
      createTool("message", {
        execute: vi.fn(async () => {
          hasRepliedRef.value = true;
          return textToolResult("Sent.", {
            messageId: "implicit-thread-message",
            messageDelivery: { status: "settled", partialDelivery: false, createdThreadIds: [] },
          });
        }),
      }),
      {
        hookContext: {
          currentChannelProvider: "slack",
          currentChannelId: "D1",
          currentMessagingTarget: "user:u1",
          currentThreadId: "171.222",
          replyToMode: "first",
          hasRepliedRef,
        },
      },
    );

    await handleMessageToolCall(bridge, {
      action: "send",
      to: "user:U1",
      text: "hello from Codex",
    });

    expect(bridge.telemetry.messagingToolSentTargets).toEqual([
      {
        tool: "message",
        provider: "slack",
        to: "user:u1",
        threadId: "171.222",
        threadImplicit: true,
        text: "hello from Codex",
      },
    ]);
  });

  it.each(["replaced", "failed", "preserved", "older"] as const)(
    "retains computer frame authority only for its delivered screenshot (%s)",
    async (mode) => {
      const handler = vi.fn(async (event: { result: AgentToolResult<unknown> }) => {
        if (mode === "failed") {
          throw new Error("middleware exploded");
        }
        const content = [frameImage(REPLACEMENT_FRAME_IMAGE)];
        return { result: { ...event.result, content } };
      });
      if (mode === "replaced" || mode === "failed") {
        installResultMiddleware(handler);
      }
      const newerEpoch = { value: 2, frameToolCallId: "shot-newer" };
      const { bridge, computerContextEpoch } =
        mode === "older"
          ? {
              bridge: createSingleToolBridge(
                createTool("computer", {
                  execute: vi.fn(async () => textToolResult("older result")),
                }),
                { computerContextEpoch: newerEpoch },
              ),
              computerContextEpoch: newerEpoch,
            }
          : createScreenshotBridge();
      const result = await callTool(
        bridge,
        "computer",
        mode === "older" ? {} : { action: "screenshot" },
        mode === "older" ? "shot-older" : "shot-1",
      );
      if (mode === "preserved") {
        expect(computerContextEpoch).toEqual({
          value: 0,
          frameToolCallId: "shot-1",
          frameImageIdentity: frameImageIdentity(COMPUTER_FRAME_IMAGE),
        });
      } else if (mode === "older") {
        expect(computerContextEpoch).toEqual({ value: 2, frameToolCallId: "shot-newer" });
      } else {
        expect(computerContextEpoch).toEqual({ value: 1 });
        if (mode === "replaced") {
          expect(result.contentItems).toEqual([
            { type: "inputImage", imageUrl: `data:image/png;base64,${REPLACEMENT_FRAME_IMAGE}` },
          ]);
        } else {
          expectInputText(result, "Tool output unavailable due to post-processing error.", false);
          expect(handler).toHaveBeenCalledOnce();
          expect(result.executionStarted).toBe(true);
        }
      }
    },
  );

  it("preserves successful execution when its observer throws an unreadable error", async () => {
    const { onAgentToolResult, warn } = throwingResultObserver();
    const rawResult = textToolResult("committed effect", { receipt: "effect-1" });
    const { execute, bridge } = mockToolBridge("exec", rawResult);
    const result = await callTool(
      bridge,
      "exec",
      { command: "write synthetic effect" },
      "observer-success",
      { onAgentToolResult },
    );
    expect(execute).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      success: true,
      diagnosticTerminalType: "completed",
      executionStarted: true,
      sideEffectEvidence: true,
      contentItems: inputText("committed effect"),
      transcriptDetails: { receipt: "effect-1" },
    });
    const protocolResponse = toCodexDynamicToolProtocolResponse(result);
    expect(protocolResponse).not.toHaveProperty("transcriptDetails");
    expect(JSON.stringify(protocolResponse)).not.toContain("effect-1");
    expect(onAgentToolResult).toHaveBeenCalledExactlyOnceWith({
      toolName: "exec",
      result: rawResult,
      isError: false,
    });
    expect(rawResult).toEqual(textToolResult("committed effect", { receipt: "effect-1" }));
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      "onAgentToolResult handler failed: tool=exec error=Error",
    );
  });

  it("classifies replay safety for async read results", async () => {
    const bridge = createBridgeWithToolResult(
      "web_search",
      textToolResult("Background task started.", {
        async: true,
        status: "started",
        taskId: "task-1",
      }),
    );
    const result = await callTool(bridge, "web_search", { query: "scheduler" });
    expect(result).toMatchObject({ sideEffectEvidence: true, asyncStarted: true });
  });

  it("keeps executed mutations replay-unsafe when middleware rewrites the result as blocked", async () => {
    const handler = vi.fn(async () => ({
      result: textToolResult("blocked by middleware", {
        status: "blocked",
        deniedReason: "plugin-before-tool-call",
      }),
    }));
    installResultMiddleware(handler);
    const execute = vi.fn(async () => textToolResult("added", { id: "job-1" }));
    const bridge = createSingleToolBridge(createTool("cron", { execute }));

    const result = await callTool(
      bridge,
      "cron",
      { action: "add", job: { name: "reminder" } },
      "call-cron-rewritten-blocked",
    );

    expect(execute).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ diagnosticTerminalType: "blocked", sideEffectEvidence: true });
  });

  it("uses raw tool provenance for media trust after middleware rewrites details", async () => {
    const handler = vi.fn(async (event: { result: AgentToolResult<unknown> }) => ({
      result: {
        ...event.result,
        content: [{ type: "text" as const, text: "Generated media reply." }],
        details: { media: { mediaUrl: "/tmp/unsafe.png" } },
      },
    }));
    installResultMiddleware(handler);

    const bridge = createBridgeWithToolResult(
      "browser",
      textToolResult("raw output", { mcpServer: "external", mcpTool: "browser" }),
    );

    const result = await callTool(bridge, "browser");

    expectInputText(result, "Generated media reply.");
    expect(bridge.telemetry.toolMediaUrls).toStrictEqual([]);
  });

  it("keeps config out of Codex tool-result contexts", async () => {
    const config = { session: { store: "/tmp/openclaw-session-store.json" } };
    const registry = createEmptyPluginRegistry();
    const middlewareContexts: Record<string, unknown>[] = [];
    const middleware = vi.fn(async (eventValue: unknown, ctx: Record<string, unknown>) => {
      middlewareContexts.push(ctx);
      return undefined;
    });
    registry.agentToolResultMiddlewares.push({
      pluginId: "tokenjuice",
      pluginName: "Tokenjuice",
      rawHandler: middleware,
      handler: middleware,
      runtimes: ["codex"],
      source: "test",
    });
    setActivePluginRegistry(registry);

    const expectedContext = {
      agentId: "agent-1",
      sessionId: "session-1",
      sessionKey: "agent:agent-1:session-1",
      runId: "run-1",
    };
    const { execute, bridge } = mockToolBridge("exec", textToolResult("done"), {
      hookContext: { ...expectedContext, config: config as never },
    });
    await callTool(bridge, "exec", { command: "pwd" });
    expectExecuteCall(execute, { callId: "call-1", args: { command: "pwd" } });
    expect(middlewareContexts).toEqual([
      expect.objectContaining({ ...expectedContext, runtime: "codex" }),
    ]);
    expect(middlewareContexts[0]).not.toHaveProperty("config");
  });

  it.each([false, true])(
    "retains the execution boundary through pending middleware (blocked: %s)",
    async (blocked) => {
      const runId = blocked ? "run-blocked-middleware" : "run-delayed-middleware";
      const callId = blocked ? "call-blocked-middleware" : "call-delayed-middleware";
      initializeGlobalHookRunner(
        createMockPluginRegistry([
          {
            hookName: "before_tool_call",
            handler: vi.fn(async () =>
              blocked
                ? { block: true, blockReason: "blocked by policy" }
                : { params: { target: "channel:adjusted" } },
            ),
          },
        ]),
      );
      const { entered, release } = holdResults();
      const execute = vi.fn(async () => textToolResult(blocked ? "should not run" : "ok"));
      const bridge = createSingleToolBridge(createTool("message", { execute }), {
        hookContext: { runId },
      });

      const result = callTool(
        bridge,
        "message",
        blocked
          ? { action: "send", text: "blocked" }
          : { action: "send", target: "channel:original", text: "hello" },
        callId,
        { retainExecutionSnapshot: true },
      );
      await entered.promise;

      expect(bridge.consumeToolExecutionSnapshot?.(callId)).toEqual({
        executedArguments: blocked
          ? { action: "send", text: "blocked" }
          : { action: "send", target: "channel:adjusted", text: "hello" },
        executionStarted: !blocked,
      });
      if (blocked) {
        expect(execute).not.toHaveBeenCalled();
      }
      release.resolve();
      await result;
      expect(bridge.consumeToolExecutionSnapshot?.(callId)).toBeUndefined();
    },
  );

  it("does not recreate a retained snapshot after its timeout owner consumes it", async () => {
    const runId = "run-late-abort";
    const callId = "call-late-abort";
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_tool_call",
          handler: vi.fn(async () => ({ params: { target: "channel:adjusted" } })),
        },
      ]),
    );
    const execute = vi.fn(
      async (_callId: string, _args: unknown, signal?: AbortSignal) =>
        await new Promise<never>((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () =>
              reject(signal.reason instanceof Error ? signal.reason : new Error("tool aborted")),
            { once: true },
          );
        }),
    );
    const bridge = createSingleToolBridge(createTool("message", { execute }), {
      hookContext: { runId },
    });
    const controller = new AbortController();
    const result = callTool(
      bridge,
      "message",
      { action: "send", target: "channel:original", text: "hello" },
      callId,
      { signal: controller.signal, retainExecutionSnapshot: true },
    );
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());

    controller.abort(new Error("tool timed out"));
    expect(bridge.consumeToolExecutionSnapshot?.(callId)).toBeUndefined();
    await expect(result).resolves.toMatchObject({ success: false });
    expect(bridge.consumeToolExecutionSnapshot?.(callId)).toBeUndefined();
  });

  it.each(["report-only", "scheduled"] as const)(
    "rejects unavailable approval in %s calls",
    async (mode) => {
      await captureRuntimeConfigAsyncReader()();
      const scheduled = mode === "scheduled";
      const requester = {
        channel: "telegram",
        accountId: "bot-a",
        senderId: "sender-a",
        senderIsOwner: true,
        roleIds: ["operator"],
      };
      const beforeToolCall = vi.fn(async () => ({
        requireApproval: {
          pluginId: "test-plugin",
          title: "Needs approval",
          description: "Review before running",
        },
      }));
      initializeGlobalHookRunner(
        createMockPluginRegistry([{ hookName: "before_tool_call", handler: beforeToolCall }]),
      );
      const execute = vi.fn(async () => textToolResult("should not run"));
      const rawTool = createTool("exec", { execute });
      const tool = scheduled
        ? rawTool
        : wrapToolWithBeforeToolCallHook(
            rawTool,
            { runId: "run-approval-report" },
            { approvalMode: "report" },
          );
      const bridge = createSingleToolBridge(tool, {
        hookContext: scheduled
          ? {
              config: {},
              trigger: "cron",
              runId: "run-scheduled-hook",
              sessionId: "session-scheduled-hook",
              sessionKey: "agent:main:cron:job-1",
              requester,
              turnSourceChannel: "telegram",
              turnSourceTo: "chat-a",
              turnSourceAccountId: "bot-a",
              turnSourceThreadId: "topic-a",
            }
          : { runId: "run-approval-report" },
      });

      const result = await callTool(
        bridge,
        "exec",
        { command: "pwd" },
        scheduled ? "call-scheduled-hook" : "call-approval-report",
      );

      expect(execute).not.toHaveBeenCalled();
      if (!scheduled) {
        expect(result).toMatchObject({
          success: false,
          diagnosticTerminalType: "blocked",
        });
        expect(result.diagnosticTerminalReason).toBeUndefined();
        expect(result.sideEffectEvidence).toBeUndefined();
        return;
      }
      expect(result).toMatchObject({
        success: false,
        contentItems: inputText(
          expect.stringContaining("cron runs have no approval-capable initiating surface"),
        ),
      });
      expect(callArg(beforeToolCall, 0, 1, "scheduled before_tool_call context")).toMatchObject({
        requester: {
          channel: "telegram",
          accountId: "bot-a",
          senderId: "sender-a",
          senderIsOwner: true,
          roleIds: ["operator"],
        },
      });
    },
  );

  it.each([false, true])(
    "preserves delivery evidence when middleware fails (internal reply: %s)",
    async (internal) => {
      const handler = vi.fn((event: { result: AgentToolResult<unknown> }) => {
        const details = requireRecord(event.result.details, "message details");
        if (internal) {
          details.messageId = "forged-by-middleware";
        } else {
          const providerResult = requireRecord(details.result, "provider result");
          delete providerResult.messageId;
        }
        throw new Error("redaction failed");
      });
      installResultMiddleware(handler);
      const bridge = createBridgeWithToolResult(
        "message",
        internal
          ? textToolResult("queued for internal delivery", {
              status: "ok",
              deliveryStatus: "sent",
              sourceReplySink: "internal-ui",
              sourceReply: { text: "visible reply" },
            })
          : textToolResult("raw result must stay private", {
              ok: true,
              result: {
                messageId: "1700000000.000100",
                channelId: "C123",
                threadId: "1700000000.000000",
              },
            }),
      );

      const result = await handleMessageToolCall(bridge, {
        action: "send",
        target: "C123",
        text: "hello",
      });

      expectInputText(
        result,
        internal
          ? "Tool output unavailable due to post-processing error."
          : "Message delivered, but result post-processing failed.",
        !internal,
      );
      expect(result.sideEffectEvidence).toBe(true);
    },
  );

  it("passes per-call abort signals into dynamic tool execution", async () => {
    const started = createDeferred<AbortSignal>();
    const release = createDeferred<AgentToolResult<unknown>>();
    const execute = vi.fn(
      async (_callId: string, _args: Record<string, unknown>, signal: AbortSignal) => {
        started.resolve(signal);
        return await release.promise;
      },
    );
    const runController = new AbortController();
    const callController = new AbortController();
    const bridge = createSingleToolBridge(createTool("exec", { execute }), {
      signal: runController.signal,
    });

    const result = callTool(bridge, "exec", { command: "sleep" }, "call-signal", {
      signal: callController.signal,
    });
    const capturedSignal = await started.promise;

    callController.abort(new Error("deadline"));
    expect(capturedSignal.aborted).toBe(true);
    release.resolve(textToolResult("done"));

    expectInputText(await result, "done");
  });
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function deliveredMessageDetails(primaryPlatformMessageId: string) {
  return {
    messageDelivery: {
      status: "settled",
      partialDelivery: false,
      createdThreadIds: [],
      primaryPlatformMessageId,
    },
  };
}

it("preserves accepted child receipts when middleware strips their details", async () => {
  const receipt = {
    runId: "run_compacted",
    childSessionKey: "child-compacted",
    expectsCompletionMessage: false,
    sessionUrl: "https://openclaw.example/chat/main/work",
    label: "Review",
  };
  const onAgentToolResult = vi.fn();
  installResultMiddleware(async (event) => ({
    result: {
      ...event.result,
      content: [{ type: "text", text: "Child launch recorded." }],
      details: {},
    },
  }));
  const bridge = createSingleToolBridge(
    createTool("sessions_spawn", {
      parameters: Type.Object({ task: Type.String() }),
      execute: async () =>
        textToolResult("Accepted: launching child session.", { status: "accepted", ...receipt }),
    }),
  );
  const result = await callTool(bridge, "sessions_spawn", { task: "scan logs" }, "call-compacted", {
    onAgentToolResult,
  });
  expectInputText(result, "Child launch recorded.");
  expect(onAgentToolResult).toHaveBeenCalledWith(
    expect.objectContaining({ toolName: "sessions_spawn", isError: false }),
  );
  expect(bridge.telemetry.acceptedSessionSpawns).toEqual([receipt]);
});

it("records the hook-selected file after remote Slack upload preparation", async () => {
  await withOpenClawTestState(
    { layout: "state-only", prefix: "codex-remote-slack-upload-" },
    async () => {
      const workspaceDir = tempDirs.make("codex-remote-upload-");
      const relativePath = "reports/slack-upload.txt";
      const localPath = path.join(workspaceDir, relativePath);
      const remoteContent = "authoritative remote Slack attachment\n";
      await mkdir(path.dirname(localPath), { recursive: true });
      await writeFile(localPath, remoteContent);

      const remotePath = `/remote/codex-workspace/${relativePath}`;
      const hookSelectedPath = path.join(workspaceDir, "hook-selected-upload.txt");
      await writeFile(hookSelectedPath, "hook-selected attachment\n");
      initializeGlobalHookRunner(
        createMockPluginRegistry([
          {
            hookName: "before_tool_call",
            handler: vi.fn(async () => ({ params: { filePath: hookSelectedPath } })),
          },
        ]),
      );
      const readRemoteWorkspaceFile = vi.fn<RemoteWorkspaceFileReader>(async () =>
        Buffer.from(remoteContent),
      );
      const { bridge, execute } = mockToolBridge(
        "message",
        textToolResult("Uploaded.", deliveredMessageDetails("message-1")),
        {
          hookContext: {
            workspaceDir,
            remoteWorkspaceRoot: "/remote/codex-workspace",
            remoteWorkspaceRequestTimeoutMs: 90_000,
          },
        },
      );
      bridge.setRemoteWorkspaceFileReader?.(readRemoteWorkspaceFile);

      const result = await handleMessageToolCall(bridge, {
        action: "upload-file",
        channel: "slack",
        to: "channel:C123",
        filePath: remotePath,
      });

      expectInputText(result, "Uploaded.");
      const executedArgs = requireRecord(execute.mock.calls[0]?.[1], "upload args");
      const deliveredPath = executedArgs.filePath;
      expect(result.executedArguments).toEqual(executedArgs);
      expect(bridge.telemetry.messagingToolSentMediaUrls).toContain(deliveredPath);
      expect(bridge.telemetry.messagingToolSentTargets).toEqual([
        expect.objectContaining({
          provider: "slack",
          to: "channel:C123",
          mediaUrls: expect.arrayContaining([deliveredPath]),
        }),
      ]);
      expect(readRemoteWorkspaceFile).toHaveBeenCalledWith({
        path: remotePath,
        maxBytes: 64 * 1024 * 1024,
        workspaceRoot: "/remote/codex-workspace",
        signal: expect.any(AbortSignal),
        timeoutMs: expect.any(Number),
      });
      expect(readRemoteWorkspaceFile.mock.calls[0]?.[0].timeoutMs).toBeGreaterThan(0);
      expect(readRemoteWorkspaceFile.mock.calls[0]?.[0].timeoutMs).toBeLessThanOrEqual(90_000);
      expect(deliveredPath).toBe(hookSelectedPath);
      expect(bridge.telemetry.messagingToolSentMediaUrls).not.toContain(remotePath);
      expect(bridge.telemetry.messagingToolSentMediaUrls).not.toContain(localPath);
      expect(
        bridge.telemetry.messagingToolSentTargets.flatMap((target) => target.mediaUrls ?? []),
      ).not.toContain(remotePath);
      await expect(readFile(String(deliveredPath), "utf8")).resolves.toBe(
        "hook-selected attachment\n",
      );
      await expect(readFile(localPath, "utf8")).resolves.toBe(remoteContent);
    },
  );
});
describe("Codex automation tool references", () => {
  function setup(options: { registeredSpecs?: CodexDynamicToolSpec[] } = {}) {
    const execute = vi.fn(async (_id: string, args: unknown) => textToolResult("observed", args));
    const tools = [
      createTool("automations", { execute }),
      createTool("sandbox_exec", { catalogMode: "direct-only" }),
      ...["read", "fixture__lookup_note", "openclaw__read", "openclaw_direct__read", "_probe"].map(
        (name) => createTool(name),
      ),
    ];
    const bridge = createBridge(tools, {
      registeredSpecs: options.registeredSpecs,
      loading: "searchable",
    });
    async function call(args: JsonValue) {
      return bridge.handleToolCall({
        ...createDynamicToolCall("automations", args),
        namespace: "openclaw",
      });
    }
    return { call, execute };
  }

  function automationArgs(toolsAllow: JsonValue): JsonValue {
    return {
      action: "add",
      job: {
        name: "reminder",
        payload: { kind: "agentTurn", message: "Read the note.", toolsAllow },
      },
    };
  }

  function received(execute: ReturnType<typeof setup>["execute"]) {
    expect(execute).toHaveBeenCalledTimes(1);
    return execute.mock.calls[0]?.[1];
  }

  it.each([
    {
      label: "unknown, wrong-namespace and non-string entries",
      toolsAllow: [
        "openclaw__missing",
        "openclaw__sandbox_exec",
        "openclaw_direct__fixture__lookup_note",
        7,
        "read",
      ],
    },
    { label: "a non-array allowlist", toolsAllow: null },
  ])("leaves $label unchanged for the automation validator", async ({ toolsAllow }) => {
    const { call, execute } = setup();
    const input = automationArgs(toolsAllow);
    await call(input);
    expect(received(execute)).toEqual(input);
  });

  it("uses inherited native declarations instead of guessing namespaces from executable metadata", async () => {
    const { call, execute } = setup({
      registeredSpecs: [
        {
          type: "namespace",
          name: "openclaw_direct",
          description: "Inherited declaration",
          tools: ["automations", "read"].map((name) => ({
            type: "function",
            name,
            description: name,
            inputSchema: { type: "object", properties: {} },
          })),
        },
      ],
    });
    await call(automationArgs(["openclaw_direct__read", "openclaw__read"]));
    expect(received(execute)).toEqual(automationArgs(["read", "openclaw__read"]));
  });

  it.each<{ label: string; wrap: (toolsAllow: string[]) => JsonValue }>([
    {
      label: "data-wrapped job",
      wrap: (toolsAllow) => ({ action: "add", job: { data: { payload: { toolsAllow } } } }),
    },
    {
      label: "job-wrapped patch",
      wrap: (toolsAllow) => ({ action: "update", job: { job: { toolsAllow } } }),
    },
    {
      label: "recoverable padded field",
      wrap: (toolsAllow) => ({ action: "add", job: { "toolsAllow ": toolsAllow } }),
    },
    {
      label: "recoverable concatenated payload",
      wrap: (toolsAllow) => ({ action: "add", namePayload: { toolsAllow } }),
    },
  ])("resolves references without rewriting the supported $label shape", async ({ wrap }) => {
    const { call, execute } = setup();
    const input = wrap(["openclaw__fixture__lookup_note"]);
    const original = structuredClone(input);
    await call(input);
    expect(received(execute)).toEqual(wrap(["fixture__lookup_note"]));
    expect(input).toEqual(original);
  });
});

describe("Codex tool operator hints", () => {
  afterEach(() => vi.restoreAllMocks());

  it("keeps Codex apply_patch containment diagnostics operator-only", async () => {
    await withOpenClawTestState({ layout: "split", prefix: "codex-patch-hint-" }, async (state) => {
      const root = state.workspaceDir;
      const outside = state.path("outside.txt");
      await writeFile(outside, "original\n");
      const tools = createOpenClawCodingTools({
        workspaceDir: root,
        config: {},
        toolConstructionPlan: {
          includeBaseCodingTools: false,
          includeShellTools: true,
          includeChannelTools: false,
          includeOpenClawTools: false,
          includePluginTools: false,
        },
      }).filter((tool) => tool.name === "apply_patch");
      expect(tools).toHaveLength(1);
      const logError = vi.spyOn(embeddedAgentLog, "error").mockImplementation(() => {});
      const onAgentToolResult = vi.fn();
      const bridge = createBridge(tools);
      const call = createDynamicToolCall(
        "apply_patch",
        {
          input: `*** Begin Patch\n*** Update File: ${outside}\n@@\n-original\n+changed\n*** End Patch`,
        },
        "outside-patch",
      );
      const response = await bridge.handleToolCall(call, { onAgentToolResult });
      const hint = "workspace-contained by configuration";
      const message = `Path escapes sandbox root (${root}): ${outside}`;
      expect(logError).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(hint));
      expect(JSON.stringify(logError.mock.calls)).not.toContain(outside);
      expect(toCodexDynamicToolProtocolResponse(response)).toEqual({
        contentItems: inputText(message),
        success: false,
      });
      expect(onAgentToolResult).toHaveBeenCalledExactlyOnceWith({
        toolName: "apply_patch",
        result: expect.objectContaining({ content: [{ type: "text", text: message }] }),
        isError: true,
      });
      expect(JSON.stringify(onAgentToolResult.mock.calls)).not.toContain(hint);
      await expect(readFile(outside, "utf8")).resolves.toBe("original\n");
    });
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
