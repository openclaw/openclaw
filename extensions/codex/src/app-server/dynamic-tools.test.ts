import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentToolResult } from "openclaw/plugin-sdk/agent-core";
import { createOpenClawCodingTools, type AnyAgentTool } from "openclaw/plugin-sdk/agent-harness";
import {
  HEARTBEAT_RESPONSE_TOOL_NAME,
  embeddedAgentLog,
  getPluginToolMeta,
  wrapToolWithBeforeToolCallHook,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  buildContractReplyPayloads,
  createContractToolTerminalObserver,
  createOwnerBackedContractTool,
} from "openclaw/plugin-sdk/agent-runtime-test-contracts";
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
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { createOpenClawTestState, withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { estimateToolResultTextChars } from "openclaw/plugin-sdk/text-utility-runtime";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  handleDynamicToolCallWithTimeout,
  toCodexDynamicToolProtocolResponse,
} from "./dynamic-tool-execution.js";
import {
  createCodexDynamicToolBridge,
  projectCodexExecutableDynamicTools,
} from "./dynamic-tools.js";
import {
  CODEX_OPENCLAW_DIRECT_DYNAMIC_TOOL_NAMESPACE,
  type CodexDynamicToolCallParams,
  type CodexDynamicToolCallResponse,
  type CodexDynamicToolFunctionSpec,
  type CodexDynamicToolSpec,
  type JsonValue,
} from "./protocol.js";
import { codexDynamicToolsFingerprint } from "./thread-fingerprints.js";

const CODEX_OPENCLAW_DYNAMIC_TOOL_NAMESPACE = "openclaw";

const COMPUTER_FRAME_IMAGE =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
const REPLACEMENT_FRAME_IMAGE =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=";

// Synthetic, non-usable credential fixtures for model-visible redaction coverage.
const SYNTHETIC_BEARER_CREDENTIAL = "bearer-model-visible-credential-1234567890";

function installResultMiddleware(
  handler: ReturnType<
    typeof createEmptyPluginRegistry
  >["agentToolResultMiddlewares"][number]["handler"],
) {
  const registry = createEmptyPluginRegistry();
  registry.agentToolResultMiddlewares.push({
    pluginId: "test-result",
    pluginName: "Test result",
    rawHandler: handler,
    handler,
    runtimes: ["codex"],
    source: "test",
  });
  setActivePluginRegistry(registry);
}

function createScreenshotBridge() {
  const computerContextEpoch: {
    value: number;
    frameToolCallId?: string;
    frameImageIdentity?: string;
  } = { value: 0 };
  const bridge = createSingleToolBridge(
    createTool({
      name: "computer",
      execute: vi.fn(async (toolCallId: string) => {
        computerContextEpoch.frameToolCallId = toolCallId;
        computerContextEpoch.frameImageIdentity = frameImageIdentity(COMPUTER_FRAME_IMAGE);
        return {
          content: [{ type: "image" as const, data: COMPUTER_FRAME_IMAGE, mimeType: "image/png" }],
          details: {},
        };
      }),
    }),
    {
      computerContextEpoch,
    },
  );

  return { bridge, computerContextEpoch };
}

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

function createDynamicToolCall(
  tool: string,
  arguments_: JsonValue = {},
  callId = "call-1",
): CodexDynamicToolCallParams {
  return {
    threadId: "thread-1",
    turnId: "turn-1",
    callId,
    namespace: null,
    tool,
    arguments: arguments_,
  };
}

function createTool(overrides: Partial<AnyAgentTool>): AnyAgentTool {
  return {
    name: "tts",
    description: "Convert text to speech.",
    parameters: { type: "object", properties: {}, additionalProperties: true },
    execute: vi.fn(),
    ...overrides,
  } as unknown as AnyAgentTool;
}

function mediaResult(mediaUrl: string, audioAsVoice?: boolean): AgentToolResult<unknown> {
  return {
    content: [{ type: "text", text: "Generated media reply." }],
    details: {
      media: {
        mediaUrl,
        ...(audioAsVoice === true ? { audioAsVoice: true } : {}),
      },
    },
  };
}

function textToolResult(text: string, details: unknown = {}): AgentToolResult<unknown> {
  return { content: [{ type: "text", text }], details };
}

function createSingleToolBridge(
  tool: AnyAgentTool,
  options: Omit<Parameters<typeof createCodexDynamicToolBridge>[0], "tools" | "signal"> = {},
) {
  return createCodexDynamicToolBridge({
    tools: [tool],
    signal: new AbortController().signal,
    ...options,
  });
}

function createBridgeWithToolResult(
  toolName: string,
  toolResult: AgentToolResult<unknown>,
  hookContext?: Parameters<typeof createCodexDynamicToolBridge>[0]["hookContext"],
) {
  return createSingleToolBridge(
    createTool({ name: toolName, execute: vi.fn(async () => toolResult) }),
    { hookContext },
  );
}

function firstInputText(response: CodexDynamicToolCallResponse) {
  const firstItem = response.contentItems[0];
  if (firstItem?.type !== "inputText" || typeof firstItem.text !== "string") {
    throw new Error("expected inputText tool result");
  }
  return firstItem.text;
}

function expectInputText(response: CodexDynamicToolCallResponse, text: string, success = true) {
  expect(toCodexDynamicToolProtocolResponse(response)).toEqual({
    success,
    contentItems: [{ type: "inputText", text }],
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

function flattenSpecsWithNamespace(
  specs: readonly CodexDynamicToolSpec[],
): Array<CodexDynamicToolFunctionSpec & { namespace?: string }> {
  return specs.flatMap((spec) =>
    spec.type === "namespace"
      ? spec.tools.map((tool) => ({ ...tool, namespace: spec.name }))
      : [spec],
  );
}

function specNames(specs: readonly CodexDynamicToolSpec[]): string[] {
  return flattenSpecsWithNamespace(specs).map((tool) => tool.name);
}

function expectContextFields(context: unknown, fields: Record<string, unknown>) {
  const record = requireRecord(context, "hook context");
  for (const [key, value] of Object.entries(fields)) {
    expect(record[key]).toEqual(value);
  }
}

function expectToolResult(value: unknown, expected: AgentToolResult<unknown>) {
  const result = requireRecord(value, "tool result");
  expect(result.content).toEqual(expected.content);
  expect(result.details).toEqual(expected.details);
}

function expectExecuteCall(
  execute: { mock: { calls: Array<Array<unknown>> } },
  expected: { callId: string; args: Record<string, unknown> },
) {
  expect(callArg(execute, 0, 0, "execute call id")).toBe(expected.callId);
  expect(callArg(execute, 0, 1, "execute args")).toEqual(expected.args);
  expect(callArg(execute, 0, 2, "execute signal")).toBeInstanceOf(AbortSignal);
  expect(callArg(execute, 0, 3, "execute extra")).toBeUndefined();
}

async function handleMessageToolCall(
  bridge: ReturnType<typeof createCodexDynamicToolBridge>,
  arguments_: JsonValue,
) {
  return await bridge.handleToolCall(createDynamicToolCall("message", arguments_));
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
  const tool = createTool({
    name,
    parameters: params.parameters ?? STRICT_INSTRUCTION_SCHEMA,
    prepareArguments: params.prepareArguments,
    execute,
  });
  const bridge = createCodexDynamicToolBridge({
    tools: [tool],
    signal: new AbortController().signal,
    directToolNames: params.direct ? [name] : undefined,
  });
  const response = await bridge.handleToolCall({
    threadId: "thread-1",
    turnId: "turn-1",
    callId: params.callId,
    namespace: params.direct ? CODEX_OPENCLAW_DIRECT_DYNAMIC_TOOL_NAMESPACE : null,
    tool: name,
    arguments: params.arguments,
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
    contentItems: [{ type: "inputText", text: expect.stringContaining(message) }],
  });
}

afterEach(() => {
  resetGlobalHookRunner();
  setActivePluginRegistry(createEmptyPluginRegistry());
});

describe("createCodexDynamicToolBridge", () => {
  it("awaits execution policy before dispatch and refuses a stale policy", async () => {
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    const execute = vi.fn(async () => textToolResult("executed"));
    const bridge = createSingleToolBridge(createTool({ name: "synthetic", execute }), {
      assertCurrentAsync: async () => {
        entered.resolve();
        await release.promise;
        throw new Error("execution policy changed");
      },
    });
    const pending = bridge.handleToolCall(createDynamicToolCall("synthetic"));
    await entered.promise;
    expect(execute).not.toHaveBeenCalled();
    release.resolve();
    const response = await pending;
    expect(response.success).toBe(false);
    expect(firstInputText(response)).toContain("execution policy changed");
    expect(execute).not.toHaveBeenCalled();
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
    tool.parameters = {
      type: "object",
      properties: { instruction: { type: "string" } },
      required: ["instruction"],
      additionalProperties: false,
    };
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

    const response = await bridge.handleToolCall(
      createDynamicToolCall(tool.name, { instruction: 47 }, "call-external-mcp"),
    );

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

    expect(response.terminalResolution?.lastToolError).toMatchObject({
      mutatingAction: true,
    });
    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.text).toContain("I'll remember");
    expect(JSON.stringify(toCodexDynamicToolProtocolResponse(response))).not.toContain(
      "memory-lancedb",
    );
  });

  it("keeps model-visible tools stable when plugin discovery order changes", () => {
    const tools = [
      createTool({ name: "web_search" }),
      createTool({ name: "computer", catalogMode: "direct-only" }),
      createTool({ name: "agents_list" }),
      createTool({ name: "openclaw" }),
    ];
    const createBridge = (orderedTools: AnyAgentTool[]) =>
      createCodexDynamicToolBridge({
        tools: orderedTools,
        registeredTools: orderedTools,
        signal: new AbortController().signal,
        directToolNames: ["openclaw"],
      });
    const forward = createBridge(tools);
    const reversed = createBridge(tools.toReversed());

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
    const heartbeatExecute = vi.fn(async () => textToolResult("heartbeat recorded"));
    const onToolOutcome = vi.fn();
    const bridge = createCodexDynamicToolBridge({
      tools: [createTool({ name: "message" })],
      registeredTools: [
        createTool({ name: "message" }),
        createTool({ name: HEARTBEAT_RESPONSE_TOOL_NAME, execute: heartbeatExecute }),
      ],
      signal: new AbortController().signal,
      hookContext: { runId: "run-unavailable", onToolOutcome },
    });

    expect(specNames(bridge.availableSpecs)).toEqual(["message"]);
    expect(bridge.availableTools.map((tool) => tool.name)).toEqual(["message"]);
    expect(specNames(bridge.specs)).toEqual([HEARTBEAT_RESPONSE_TOOL_NAME, "message"]);

    const result = await bridge.handleToolCall(createDynamicToolCall(HEARTBEAT_RESPONSE_TOOL_NAME));

    expectInputText(
      result,
      `OpenClaw tool is not available for this turn: ${HEARTBEAT_RESPONSE_TOOL_NAME}`,
      false,
    );
    expect(result.executionStarted).toBe(false);
    expect(result.executedArguments).toEqual({});
    expect(heartbeatExecute).not.toHaveBeenCalled();
    expect(onToolOutcome).toHaveBeenLastCalledWith({
      toolName: HEARTBEAT_RESPONSE_TOOL_NAME,
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
    const unsubscribeDiagnostics = onInternalDiagnosticEvent((event) =>
      diagnosticEvents.push(event),
    );
    const badExecute = vi.fn();
    let bridge!: ReturnType<typeof createCodexDynamicToolBridge>;
    try {
      bridge = createCodexDynamicToolBridge({
        tools: [
          createTool({ name: "message" }),
          createTool({
            name: "fuzzplugin_move_angles",
            parameters: { type: "array", items: { type: "number" } },
            execute: badExecute,
          }),
        ],
        signal: new AbortController().signal,
        hookContext: {
          agentId: "agent-quarantine",
          runId: "run-1",
          sessionId: "session-1",
          sessionKey: "global",
        },
      });
      await waitForDiagnosticEventsDrained();
    } finally {
      unsubscribeDiagnostics();
    }

    expect(specNames(bridge.availableSpecs)).toEqual(["message"]);
    expect(specNames(bridge.specs)).toEqual(["message"]);
    expect(bridge.telemetry.quarantinedTools).toEqual([
      {
        tool: "fuzzplugin_move_angles",
        violations: ['fuzzplugin_move_angles.inputSchema.type must be "object"'],
      },
    ]);
    const blockedEvents = diagnosticEvents.filter(
      (event): event is Extract<DiagnosticEventPayload, { type: "tool.execution.blocked" }> =>
        event.type === "tool.execution.blocked",
    );
    expect(blockedEvents).toContainEqual(
      expect.objectContaining({
        type: "tool.execution.blocked",
        agentId: "agent-quarantine",
        runId: "run-1",
        sessionId: "session-1",
        sessionKey: "global",
        toolName: "fuzzplugin_move_angles",
        deniedReason: "unsupported_tool_schema",
        reason: 'fuzzplugin_move_angles.inputSchema.type must be "object"',
      }),
    );

    const result = await bridge.handleToolCall(createDynamicToolCall("fuzzplugin_move_angles"));

    expectInputText(result, "Unknown OpenClaw tool: fuzzplugin_move_angles", false);
    expect(result.executionStarted).toBe(false);
    expect(result.executedArguments).toEqual({});
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
    const invalidTool = createTool({ name: testCase.name, ...placement });
    const sibling = createTool({ name: "valid_sibling", execute, ...placement });
    const registeredOnly = createTool({ name: "registered_sibling", ...placement });
    const tools = [sibling, ...(testCase.source === "registered" ? [] : [invalidTool])];
    const registeredTools = [
      sibling,
      registeredOnly,
      ...(testCase.source === "available" ? [] : [invalidTool]),
    ];
    const bridgeOptions = {
      tools,
      registeredTools,
      signal: new AbortController().signal,
      ...(testCase.placement === "direct" ? { loading: "direct" as const } : {}),
    };
    const bridge = createCodexDynamicToolBridge(bridgeOptions);
    expect(bridge.availableTools.map((tool) => tool.name)).toEqual(["valid_sibling"]);
    expect(specNames(bridge.availableSpecs)).toEqual(["valid_sibling"]);
    expect(specNames(bridge.specs).toSorted()).toEqual(["registered_sibling", "valid_sibling"]);
    expect(bridge.telemetry.quarantinedTools).toEqual([
      expect.objectContaining({ tool: testCase.name }),
    ]);
    const validResult = await bridge.handleToolCall(
      createDynamicToolCall("valid_sibling", {}, "call-valid"),
    );
    expect(validResult.success).toBe(true);
    expect(execute).toHaveBeenCalledOnce();

    const invalidResult = await bridge.handleToolCall(
      createDynamicToolCall(testCase.name, {}, "call-invalid"),
    );
    expect(invalidResult).toMatchObject({
      success: false,
      executionStarted: false,
    });
    expect(invalidResult.contentItems).toEqual([
      {
        type: "inputText",
        text: `Unknown OpenClaw tool: ${testCase.name}`,
      },
    ]);
  });

  it("uses the bridge's executable projection for authority snapshots", () => {
    const tools = [
      createTool({ name: "configured_ok" }),
      createTool({
        name: "configured_unsupported",
        parameters: { type: "array", items: { type: "string" } },
      }),
    ];
    const projected = projectCodexExecutableDynamicTools({ tools });
    const bridge = createCodexDynamicToolBridge({
      tools,
      signal: new AbortController().signal,
    });

    expect(projected.availableTools.map((tool) => tool.name)).toEqual(
      bridge.availableTools.map((tool) => tool.name),
    );
    expect(projected.availableTools.map((tool) => tool.name)).toEqual(["configured_ok"]);
    expect(projected.quarantinedTools).toEqual(bridge.telemetry.quarantinedTools);
  });

  it("quarantines unreadable dynamic tool descriptors without dropping healthy siblings", () => {
    vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
    function unreadable(name: string, key: string) {
      const tool = createTool({ name });
      Object.defineProperty(tool, key, {
        enumerable: true,
        get() {
          throw new Error(`Unreadable ${key}`);
        },
      });
      return tool;
    }
    const poisonedName = unreadable("fuzzplugin_unreadable_name", "name");
    const poisonedSchema = unreadable("fuzzplugin_unreadable_schema", "parameters");
    const invalidName = createTool({ name: "" });
    const poisonedExecute = unreadable("fuzzplugin_unreadable_execute", "execute");

    const bridge = createCodexDynamicToolBridge({
      tools: [
        poisonedName,
        poisonedSchema,
        invalidName,
        poisonedExecute,
        createTool({ name: "message" }),
      ],
      signal: new AbortController().signal,
    });

    expect(specNames(bridge.availableSpecs)).toEqual(["message"]);
    expect(specNames(bridge.specs)).toEqual(["message"]);
    expect(bridge.telemetry.quarantinedTools).toEqual([
      {
        tool: "tool[0]",
        violations: ["tool[0].name is unreadable"],
      },
      {
        tool: "fuzzplugin_unreadable_schema",
        violations: ["fuzzplugin_unreadable_schema.inputSchema is unreadable"],
      },
      {
        tool: "tool[2]",
        violations: ["tool[2].name must be a non-empty string"],
      },
      {
        tool: "fuzzplugin_unreadable_execute",
        violations: [
          "fuzzplugin_unreadable_execute could not be wrapped for before-tool-call hooks",
        ],
      },
    ]);
    const registeredBridge = createCodexDynamicToolBridge({
      tools: [poisonedExecute, createTool({ name: "message" })],
      registeredTools: [
        createTool({ name: "fuzzplugin_unreadable_execute" }),
        createTool({ name: "message" }),
      ],
      signal: new AbortController().signal,
    });

    expect(specNames(registeredBridge.availableSpecs)).toEqual(["message"]);
    expect(specNames(registeredBridge.specs)).toEqual(["message"]);
  });

  it("preserves the canonical cap for tiny contexts", async () => {
    const bridge = createBridgeWithToolResult("large_lookup", textToolResult("x".repeat(70_000)), {
      contextWindowTokens: 1,
    });
    const result = await bridge.handleToolCall(
      createDynamicToolCall("large_lookup", {}, "call-context-cap"),
    );
    expect(firstInputText(result).length).toBe(1);
  });

  it.each([
    { kind: "split credential", unicode: false },
    { kind: "Unicode repartition", unicode: true },
  ])("redacts adjacent text items with $kind", async ({ unicode }) => {
    const bridge = createBridgeWithToolResult("credential_lookup", {
      content: (unicode
        ? ["Authorization: Bearer abcdefg\n", "123😀tail"]
        : [
            "Deployment finished.\nAuthorization: Bearer ",
            SYNTHETIC_BEARER_CREDENTIAL,
            "\nArtifacts remain available.",
          ]
      ).map((text) => ({ type: "text", text })),
      details: {},
    });

    const result = await bridge.handleToolCall(
      createDynamicToolCall("credential_lookup", {}, "call-split-credential"),
    );

    const textItems = result.contentItems.flatMap((item) =>
      item.type === "inputText" && typeof item.text === "string" ? [item.text] : [],
    );
    if (unicode) {
      const unpairedSurrogate =
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
      expect(textItems).toHaveLength(2);
      expect(textItems.every((text) => !unpairedSurrogate.test(text))).toBe(true);
      expect(textItems.join("")).toBe("Authorization: Bearer ***\n123😀tail");
    } else {
      const text = textItems.join("");
      expect(text).not.toContain(SYNTHETIC_BEARER_CREDENTIAL);
      expect(text).toContain("Authorization: Bearer");
      expect(text).toContain("Deployment finished.");
      expect(text).toContain("Artifacts remain available.");
    }
  });

  it("redacts a credential that crosses the dynamic tool result budget", async () => {
    const maxChars = 16_000;
    const totalChars = 20_000;
    const noticeText = `...(OpenClaw truncated dynamic tool result: original ${totalChars} chars, weighted budget ${maxChars}; rerun with narrower args.)`;
    const textBudget = maxChars - noticeText.length - 1;
    // Newlines bound the credential token so the filler stays outside its mask.
    const marker = `\nAuthorization: Bearer ${SYNTHETIC_BEARER_CREDENTIAL}\n`;
    // Place the credential so an unsanitized slice would cut through it and strand a fragment.
    const prefix = "a".repeat(textBudget - 45);
    const suffix = "z".repeat(totalChars - prefix.length - marker.length);
    const bridge = createBridgeWithToolResult("credential_lookup", {
      content: [
        { type: "text", text: `${prefix}${marker}${suffix}` },
        { type: "image", mimeType: "image/png", data: COMPUTER_FRAME_IMAGE },
      ],
      details: {},
    });

    const result = await bridge.handleToolCall(
      createDynamicToolCall("credential_lookup", {}, "call-credential-budget"),
    );

    const text = result.contentItems
      .map((item) => (item.type === "inputText" && typeof item.text === "string" ? item.text : ""))
      .join("");
    expect(text).not.toContain(SYNTHETIC_BEARER_CREDENTIAL);
    expect(text).not.toContain("bearer-model-visible");
    expect(text).toContain("OpenClaw truncated dynamic tool result");
    expect(result.contentItems).toContainEqual(expect.objectContaining({ type: "inputImage" }));
  });

  it("shares weighted budget across mixed text blocks while preserving images", async () => {
    const bridge = createBridgeWithToolResult(
      "mixed_lookup",
      {
        content: [
          { type: "text", text: "a".repeat(4_000) },
          { type: "image", mimeType: "image/png", data: COMPUTER_FRAME_IMAGE },
          { type: "text", text: "你".repeat(9_000) },
        ],
        details: {},
      },
      { contextWindowTokens: 128_000 },
    );

    const result = await bridge.handleToolCall(
      createDynamicToolCall("mixed_lookup", {}, "call-mixed-weighted"),
    );
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
      const bridge = createCodexDynamicToolBridge({
        tools: [createTool({ name: tool, execute: vi.fn(async () => result) })],
        signal: outer.signal,
      });
      const handle = vi.spyOn(bridge, "handleToolCall");
      const onAgentToolResult = vi.fn();
      vi.useFakeTimers();
      try {
        const response = handleDynamicToolCallWithTimeout({
          call: {
            threadId: "thread-1",
            turnId: "turn-1",
            callId: "held-result",
            namespace: null,
            tool,
            arguments: { text: "hello" },
          },
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
              details: {
                media: {
                  mediaUrl,
                  audioAsVoice: true,
                  trustedLocalMedia: true,
                },
              },
            },
      });
      const bridge = createSingleToolBridge(tool);

      await bridge.handleToolCall(createDynamicToolCall(name, trusted ? {} : { text: "hello" }));

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
                toolContext?: {
                  currentChannelId?: string;
                  currentMessagingTarget?: string;
                  currentThreadTs?: string;
                  replyToMode?: "off" | "first" | "all" | "batched";
                  hasRepliedRef?: { value: boolean };
                };
              }) => {
                if (
                  to !== toolContext?.currentMessagingTarget &&
                  to !== toolContext?.currentChannelId
                ) {
                  return undefined;
                }
                if (
                  (toolContext?.replyToMode === "first" ||
                    toolContext?.replyToMode === "batched") &&
                  !toolContext.hasRepliedRef?.value
                ) {
                  return toolContext.currentThreadTs;
                }
                return undefined;
              },
            },
          },
          source: "test",
        },
      ]),
    );
    const bridge = createSingleToolBridge(
      createTool({
        name: "message",
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

  it("preserves implicit source delivery when middleware redacts details", async () => {
    installResultMiddleware((event) => ({
      result: { content: event.result.content, details: { redacted: true } },
    }));
    const bridge = createBridgeWithToolResult(
      "message",
      textToolResult("Sent.", {
        messageDelivery: {
          status: "settled",
          primaryPlatformMessageId: "imessage-6264",
          partialDelivery: false,
          createdThreadIds: [],
          sourceReplyDelivered: true,
        },
        receipt: {
          primaryPlatformMessageId: "imessage-6264",
          platformMessageIds: ["imessage-6264"],
        },
      }),
      { sourceReplyDeliveryMode: "message_tool_only" },
    );

    const result = await handleMessageToolCall(bridge, {
      action: "send",
      message: "visible reply",
      final: true,
    });

    expectInputText(result, "Sent.");
    expect(result.terminate).toBe(true);
    expect(bridge.telemetry.sourceReplyDelivered).toBe(true);
    expect(Object.keys(toCodexDynamicToolProtocolResponse(result))).not.toContain("terminate");
  });

  it("honors explicit progress message-tool finality", async () => {
    const bridge = createBridgeWithToolResult(
      "message",
      { ...textToolResult("Sent.", { ok: true }), terminate: true },
      {
        sourceReplyDeliveryMode: "message_tool_only",
      },
    );

    const result = await handleMessageToolCall(bridge, {
      action: "reply",
      channel: "imessage",
      target: "+12069106512",
      messageId: "868",
      message: "Still working.",
      buttons: [],
      final: false,
    });

    expectInputText(result, "Sent.");
    expect(result.terminate).toBeUndefined();
    expect(bridge.telemetry.messagingToolSentTargets.at(-1)).toMatchObject({
      sourceReplyFinal: false,
    });
  });

  it("does not let prior message-send telemetry terminate a later non-delivery tool result", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce(textToolResult("Sent.", { messageId: "source-reply-1" }))
      .mockResolvedValueOnce(textToolResult("No message sent.", { ok: true }));
    const bridge = createSingleToolBridge(createTool({ name: "message", execute }), {
      hookContext: { sourceReplyDeliveryMode: "message_tool_only" },
    });

    const firstResult = await handleMessageToolCall(bridge, {
      action: "send",
      message: "visible reply",
    });
    const secondResult = await bridge.handleToolCall(
      createDynamicToolCall("message", { action: "inspect" }, "call-2"),
    );

    expect(firstResult.terminate).toBe(true);
    expect(bridge.telemetry.didSendViaMessagingTool).toBe(true);
    expectInputText(secondResult, "No message sent.");
    expect(secondResult.terminate).toBeUndefined();
  });

  it.each(["replaced", "failed", "preserved", "older"] as const)(
    "retains computer frame authority only for its delivered screenshot (%s)",
    async (mode) => {
      const handler = vi.fn(async (event: { result: AgentToolResult<unknown> }) => {
        if (mode === "failed") {
          throw new Error("middleware exploded");
        }
        const content: AgentToolResult<unknown>["content"] = [
          { type: "image", data: REPLACEMENT_FRAME_IMAGE, mimeType: "image/png" },
        ];
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
                createTool({
                  name: "computer",
                  execute: vi.fn(async () => textToolResult("older result")),
                }),
                { computerContextEpoch: newerEpoch },
              ),
              computerContextEpoch: newerEpoch,
            }
          : createScreenshotBridge();
      const result = await bridge.handleToolCall(
        createDynamicToolCall(
          "computer",
          mode === "older" ? {} : { action: "screenshot" },
          mode === "older" ? "shot-older" : "shot-1",
        ),
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
          expect(result.success).toBe(false);
          expect(result.contentItems).toEqual([
            { type: "inputText", text: "Tool output unavailable due to post-processing error." },
          ]);
          expect(handler).toHaveBeenCalledOnce();
          expect(result.executionStarted).toBe(true);
        }
      }
    },
  );

  it("reports sanitized dynamic tool results to the private result observer", async () => {
    const onAgentToolResult = vi.fn();
    const bridge = createBridgeWithToolResult(
      "memory_lookup_custom",
      textToolResult("OPENROUTER_API_KEY=sk-or-v1-abcdef0123456789", {
        status: "failed",
        error: "backend unavailable",
      }),
    );

    await bridge.handleToolCall(createDynamicToolCall("memory_lookup_custom"), {
      onAgentToolResult,
    });

    expect(onAgentToolResult).toHaveBeenCalledOnce();
    expect(onAgentToolResult).toHaveBeenCalledWith({
      toolName: "memory_lookup_custom",
      result: {
        content: [{ type: "text", text: "OPENROUTER_API_KEY=sk-or-…6789" }],
        details: { status: "failed", error: "backend unavailable" },
      },
      isError: true,
    });
  });

  it("preserves successful execution when its observer throws an unreadable error", async () => {
    const observerError = Object.defineProperty(new Error(), "message", {
      get() {
        throw new Error("observer message getter escaped");
      },
    });
    const onAgentToolResult = vi.fn(() => {
      throw observerError;
    });
    const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => {});
    warn.mockClear();
    const rawResult = textToolResult("committed effect", { receipt: "effect-1" });
    const execute = vi.fn(async () => rawResult);
    const bridge = createSingleToolBridge(createTool({ name: "exec", execute }));
    const result = await bridge.handleToolCall(
      createDynamicToolCall("exec", { command: "write synthetic effect" }, "observer-success"),
      { onAgentToolResult },
    );
    expect(execute).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      success: true,
      diagnosticTerminalType: "completed",
      executionStarted: true,
      sideEffectEvidence: true,
      contentItems: [{ type: "inputText", text: "committed effect" }],
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
    const bridge = createSingleToolBridge(
      createTool({
        name: "web_search",
        execute: vi.fn(async () =>
          textToolResult("Background task started.", {
            async: true,
            status: "started",
            taskId: "task-1",
          }),
        ),
      }),
    );
    const result = await bridge.handleToolCall(
      createDynamicToolCall("web_search", { query: "scheduler" }),
    );
    expect(result.sideEffectEvidence).toBe(true);
    expect(result.asyncStarted).toBe(true);
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
    const bridge = createSingleToolBridge(createTool({ name: "cron", execute }));

    const result = await bridge.handleToolCall(
      createDynamicToolCall(
        "cron",
        { action: "add", job: { name: "reminder" } },
        "call-cron-rewritten-blocked",
      ),
    );

    expect(execute).toHaveBeenCalledTimes(1);
    expect(result.diagnosticTerminalType).toBe("blocked");
    expect(result.sideEffectEvidence).toBe(true);
  });

  it("uses raw tool provenance for media trust after middleware rewrites details", async () => {
    const handler = vi.fn(async (event: { result: AgentToolResult<unknown> }) => ({
      result: {
        ...event.result,
        content: [{ type: "text" as const, text: "Generated media reply." }],
        details: {
          media: {
            mediaUrl: "/tmp/unsafe.png",
          },
        },
      },
    }));
    installResultMiddleware(handler);

    const bridge = createBridgeWithToolResult("browser", {
      content: [{ type: "text", text: "raw output" }],
      details: {
        mcpServer: "external",
        mcpTool: "browser",
      },
    });

    const result = await bridge.handleToolCall(createDynamicToolCall("browser"));

    expectInputText(result, "Generated media reply.");
    expect(bridge.telemetry.toolMediaUrls).toStrictEqual([]);
  });

  it("keeps config out of Codex tool-result contexts", async () => {
    const config = { session: { store: "/tmp/openclaw-session-store.json" } };
    const registry = createEmptyPluginRegistry();
    const middlewareContexts: Record<string, unknown>[] = [];
    const legacyContexts: Record<string, unknown>[] = [];
    const middleware = vi.fn(async (eventValue: unknown, ctx: Record<string, unknown>) => {
      middlewareContexts.push(ctx);
      return undefined;
    });
    const factory = async (codex: {
      on: (
        event: "tool_result",
        handler: (
          event: unknown,
          ctx: Record<string, unknown>,
        ) => Promise<{ result: AgentToolResult<unknown> } | void>,
      ) => void;
    }) => {
      codex.on("tool_result", async (eventValue, ctx) => {
        legacyContexts.push(ctx);
      });
    };
    registry.agentToolResultMiddlewares.push({
      pluginId: "tokenjuice",
      pluginName: "Tokenjuice",
      rawHandler: middleware,
      handler: middleware,
      runtimes: ["codex"],
      source: "test",
    });
    registry.codexAppServerExtensionFactories.push({
      pluginId: "legacy",
      pluginName: "Legacy",
      rawFactory: factory,
      factory,
      source: "test",
    });
    setActivePluginRegistry(registry);

    const execute = vi.fn(async () => textToolResult("done"));
    const bridge = createSingleToolBridge(createTool({ name: "exec", execute }), {
      hookContext: {
        agentId: "agent-1",
        config: config as never,
        sessionId: "session-1",
        sessionKey: "agent:agent-1:session-1",
        runId: "run-1",
      },
    });

    await bridge.handleToolCall(createDynamicToolCall("exec", { command: "pwd" }));

    expectExecuteCall(execute, { callId: "call-1", args: { command: "pwd" } });
    expect(middlewareContexts).toHaveLength(1);
    expectContextFields(middlewareContexts[0], {
      runtime: "codex",
      agentId: "agent-1",
      sessionId: "session-1",
      sessionKey: "agent:agent-1:session-1",
      runId: "run-1",
    });
    expect(middlewareContexts[0]).not.toHaveProperty("config");
    expect(legacyContexts).toHaveLength(1);
    expectContextFields(legacyContexts[0], {
      agentId: "agent-1",
      sessionId: "session-1",
      sessionKey: "agent:agent-1:session-1",
      runId: "run-1",
    });
    expect(legacyContexts[0]).not.toHaveProperty("config");
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
      const bridge = createSingleToolBridge(createTool({ name: "message", execute }), {
        hookContext: { runId },
      });

      const result = bridge.handleToolCall(
        createDynamicToolCall(
          "message",
          blocked
            ? { action: "send", text: "blocked" }
            : { action: "send", target: "channel:original", text: "hello" },
          callId,
        ),
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
    const bridge = createSingleToolBridge(createTool({ name: "message", execute }), {
      hookContext: { runId },
    });
    const controller = new AbortController();
    const result = bridge.handleToolCall(
      createDynamicToolCall(
        "message",
        { action: "send", target: "channel:original", text: "hello" },
        callId,
      ),
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
      const scheduled = mode === "scheduled";
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
      const rawTool = createTool({ name: "exec", execute });
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
              trigger: "cron",
              runId: "run-scheduled-hook",
              sessionId: "session-scheduled-hook",
              sessionKey: "agent:main:cron:job-1",
              requester: {
                channel: "telegram",
                accountId: "bot-a",
                senderId: "sender-a",
                senderIsOwner: true,
                roleIds: ["operator"],
              },
              turnSourceChannel: "telegram",
              turnSourceTo: "chat-a",
              turnSourceAccountId: "bot-a",
              turnSourceThreadId: "topic-a",
            }
          : { runId: "run-approval-report" },
      });

      const result = await bridge.handleToolCall(
        createDynamicToolCall(
          "exec",
          { command: "pwd" },
          scheduled ? "call-scheduled-hook" : "call-approval-report",
        ),
      );

      expect(execute).not.toHaveBeenCalled();
      if (!scheduled) {
        expect(result.success).toBe(false);
        expect(result.diagnosticTerminalType).toBe("blocked");
        expect(result.diagnosticTerminalReason).toBeUndefined();
        expect(result.sideEffectEvidence).toBeUndefined();
        return;
      }
      expect(result).toMatchObject({
        success: false,
        contentItems: [
          {
            type: "inputText",
            text: expect.stringContaining("cron runs have no approval-capable initiating surface"),
          },
        ],
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

  it("applies dynamic tool result middleware before after_tool_call observes the result", async () => {
    const events: string[] = [];
    const beforeToolCall = vi.fn(async () => {
      events.push("before_tool_call");
      return { params: { mode: "safe" } };
    });
    const afterToolCall = vi.fn(async (event) => {
      events.push("after_tool_call");
      const record = requireRecord(event, "after_tool_call event");
      expect(record.params).toEqual({ command: "status", mode: "safe" });
      expectToolResult(record.result, {
        content: [{ type: "text", text: "compacted output" }],
        details: { stage: "middleware" },
      });
    });
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        { hookName: "before_tool_call", handler: beforeToolCall },
        { hookName: "after_tool_call", handler: afterToolCall },
      ]),
    );
    const handler = vi.fn(
      async (event: { args: Record<string, unknown>; result: AgentToolResult<unknown> }) => {
        events.push("middleware");
        expect(event.args).toEqual({ command: "status", mode: "safe" });
        return {
          result: {
            ...event.result,
            content: [{ type: "text" as const, text: "compacted output" }],
            details: { stage: "middleware" },
          },
        };
      },
    );
    installResultMiddleware(handler);
    const execute = vi.fn(async () => {
      events.push("execute");
      return textToolResult("raw output", { stage: "execute" });
    });
    const bridge = createSingleToolBridge(createTool({ name: "exec", execute }), {
      hookContext: { runId: "run-middleware" },
    });

    const result = await bridge.handleToolCall(
      createDynamicToolCall("exec", { command: "status" }),
    );

    expectInputText(result, "compacted output");
    await vi.waitFor(() => {
      expect(events).toEqual(["before_tool_call", "execute", "middleware", "after_tool_call"]);
    });
  });

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
    let capturedSignal: AbortSignal | undefined;
    let resolveTool: ((result: AgentToolResult<unknown>) => void) | undefined;
    const execute = vi.fn(
      async (_callId: string, _args: Record<string, unknown>, signal: AbortSignal) =>
        await new Promise<AgentToolResult<unknown>>((resolve) => {
          capturedSignal = signal;
          resolveTool = resolve;
        }),
    );
    const runController = new AbortController();
    const callController = new AbortController();
    const bridge = createCodexDynamicToolBridge({
      tools: [createTool({ name: "exec", execute })],
      signal: runController.signal,
    });

    const result = bridge.handleToolCall(
      createDynamicToolCall("exec", { command: "sleep" }, "call-signal"),
      { signal: callController.signal },
    );
    await vi.waitFor(() => {
      if (!capturedSignal) {
        throw new Error("expected dynamic tool call signal");
      }
    });
    if (!capturedSignal) {
      throw new Error("expected dynamic tool call signal");
    }

    callController.abort(new Error("deadline"));
    expect(capturedSignal.aborted).toBe(true);
    resolveTool?.(textToolResult("done"));

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

function createMediaMessageBridge(
  toolResult: AgentToolResult<unknown>,
  hookContext?: Parameters<typeof createCodexDynamicToolBridge>[0]["hookContext"],
) {
  const execute = vi.fn(async (_callId: string, _args: unknown) => toolResult);
  const bridge = createCodexDynamicToolBridge({
    tools: [createTool({ name: "message", execute })],
    signal: new AbortController().signal,
    hookContext,
  });
  return { bridge, execute };
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
    createTool({
      name: "sessions_spawn",
      parameters: Type.Object({ task: Type.String() }),
      execute: async () =>
        textToolResult("Accepted: launching child session.", { status: "accepted", ...receipt }),
    }),
  );
  const result = await bridge.handleToolCall(
    createDynamicToolCall("sessions_spawn", { task: "scan logs" }, "call-compacted"),
    { onAgentToolResult },
  );
  expectInputText(result, "Child launch recorded.");
  expect(onAgentToolResult).toHaveBeenCalledWith(
    expect.objectContaining({ toolName: "sessions_spawn", isError: false }),
  );
  expect(bridge.telemetry.acceptedSessionSpawns).toEqual([receipt]);
});

describe("Codex dynamic tool media delivery", () => {
  it("records the hook-selected file after remote Slack upload preparation", async () => {
    const openClawState = await createOpenClawTestState({
      layout: "state-only",
      prefix: "codex-remote-slack-upload-",
    });
    const workspaceDir = tempDirs.make("codex-remote-upload-");
    try {
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
      const { bridge, execute } = createMediaMessageBridge(
        textToolResult("Uploaded.", deliveredMessageDetails("message-1")),
        {
          workspaceDir,
          remoteWorkspaceRoot: "/remote/codex-workspace",
          remoteWorkspaceRequestTimeoutMs: 90_000,
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
    } finally {
      await openClawState.cleanup();
    }
  });
});
describe("Codex automation tool references", () => {
  function tool(name: string, overrides: Partial<AnyAgentTool> = {}): AnyAgentTool {
    return {
      name,
      label: name,
      description: `Test ${name}`,
      parameters: Type.Object({}, { additionalProperties: true }),
      execute: async () => ({ content: [], details: {} }),
      ...overrides,
    };
  }

  function setup(options: { registeredSpecs?: CodexDynamicToolSpec[] } = {}) {
    const execute = vi.fn(async (_id: string, args: unknown) => ({
      content: [{ type: "text" as const, text: "observed" }],
      details: args,
    }));
    const tools = [
      tool("automations", { execute }),
      tool("read"),
      tool("sandbox_exec", { catalogMode: "direct-only" }),
      tool("fixture__lookup_note"),
      tool("openclaw__read"),
      tool("openclaw_direct__read"),
      tool("_probe"),
    ];
    const bridge = createCodexDynamicToolBridge({
      tools,
      registeredSpecs: options.registeredSpecs,
      signal: new AbortController().signal,
      loading: "searchable",
    });
    async function call(args: JsonValue) {
      return bridge.handleToolCall({
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-1",
        namespace: "openclaw",
        tool: "automations",
        arguments: args,
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

  it("keeps exact canonical names before resolving a colliding qualified reference", async () => {
    const { call, execute } = setup();
    await call(
      automationArgs(["openclaw__read", "openclaw_direct__read", "openclaw__openclaw__read"]),
    );
    expect(received(execute)).toEqual(
      automationArgs(["openclaw__read", "openclaw_direct__read", "openclaw__read"]),
    );
  });

  it("leaves unknown, wrong-namespace and non-string values unchanged", async () => {
    const { call, execute } = setup();
    const input = automationArgs([
      "openclaw__missing",
      "openclaw__sandbox_exec",
      "openclaw_direct__fixture__lookup_note",
      7,
      "read",
    ]);
    await call(input);
    expect(received(execute)).toEqual(input);
  });

  it("leaves a non-array allowlist for the automation validator", async () => {
    const { call, execute } = setup();
    const input = automationArgs(null);
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
      const bridge = createCodexDynamicToolBridge({
        tools,
        signal: new AbortController().signal,
      });
      const call = {
        threadId: "thread-patch-hint",
        turnId: "turn-patch-hint",
        callId: "outside-patch",
        namespace: null,
        tool: "apply_patch",
        arguments: {
          input: `*** Begin Patch\n*** Update File: ${outside}\n@@\n-original\n+changed\n*** End Patch`,
        },
      };
      const response = await bridge.handleToolCall(call, { onAgentToolResult });
      const hint = "workspace-contained by configuration";
      const message = `Path escapes sandbox root (${root}): ${outside}`;
      expect(logError).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(hint));
      expect(toCodexDynamicToolProtocolResponse(response)).toEqual({
        contentItems: [{ type: "inputText", text: message }],
        success: false,
      });
      expect(onAgentToolResult).toHaveBeenCalledExactlyOnceWith({
        toolName: "apply_patch",
        result: expect.objectContaining({
          content: [{ type: "text", text: message }],
        }),
        isError: true,
      });
      expect(JSON.stringify(onAgentToolResult.mock.calls)).not.toContain(hint);
      await expect(readFile(outside, "utf8")).resolves.toBe("original\n");
    });
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
