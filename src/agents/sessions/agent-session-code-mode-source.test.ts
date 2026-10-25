import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { streamAnthropic } from "@openclaw/ai/internal/anthropic";
import { streamOpenAIResponses } from "@openclaw/ai/internal/openai";
import type { AssistantMessage, Context, Model, ToolResultMessage } from "openclaw/plugin-sdk/llm";
import { Type } from "typebox";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import {
  appendTranscriptMessages,
  appendTranscriptMessageSync,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "../../config/sessions/session-sqlite-target.js";
import type { OpenClawConfig } from "../../config/types.js";
import { resetDiagnosticEventsForTest } from "../../infra/diagnostic-events.js";
import { createDiagnosticTraceContext } from "../../infra/diagnostic-trace-context.js";
import { resetDiagnosticRunActivityForTest } from "../../logging/diagnostic-run-activity.js";
import { resetLogger } from "../../logging/logger.js";
import { registerSecretValueForRedaction } from "../../logging/secret-redaction-registry.js";
import { resetSecretRedactionRegistryForTest } from "../../logging/secret-redaction-registry.test-support.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../../plugins/hooks.test-helpers.js";
import { createNestedToolActivity } from "../../sessions/nested-tool-activity.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  closeOpenClawAgentDatabasesAsync,
} from "../../state/openclaw-agent-db.js";
import {
  cleanupSessionStateForTest,
  drainSessionStateForTest,
} from "../../test-utils/session-state-cleanup.js";
import { toToolDefinitions } from "../agent-tool-definition-adapter.js";
import { createOpenClawReadTool } from "../agent-tools.read.js";
import { createCodeModeHarness, resetCodeModeTestState } from "../code-mode.test-support.js";
import { buildEmbeddedExtensionFactories } from "../embedded-agent-runner/extensions.js";
import { normalizeMessagesForLlmBoundary } from "../embedded-agent-runner/run/attempt-llm-boundary.js";
import { wrapStreamFnWithDiagnosticModelCallEvents } from "../embedded-agent-runner/run/attempt.model-diagnostic-events.js";
import { installToolResultContextGuard } from "../embedded-agent-runner/tool-result-context-guard.js";
import type { AgentMessage } from "../runtime/index.js";
import { guardSessionManager } from "../session-tool-result-guard-wrapper.js";
import { registerHeadlessToolSearchCatalog } from "../tool-search.js";
import { sessionTarget } from "./agent-session-boundary.test-support.js";
import {
  createAssistant,
  createAssistantResultStream,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
  testModel,
} from "./agent-session-loop-correctness.test-support.js";
import { createResourceLoader } from "./agent-session-loop-resource-loader.test-support.js";
import type { AgentSession } from "./agent-session.js";
import type { MessageEndEvent, ToolDefinition } from "./extensions/types.js";
import { DefaultResourceLoader } from "./resource-loader.js";
import { SessionManager } from "./session-manager.js";
import { createReadTool } from "./tools/read.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterAll(async () => {
    for (const stateDir of tempDirs.dirs) {
      await cleanupSessionStateForTest({ stateDir });
    }
    cleanup();
  }),
);
let fixtureDir: string;
let sessionSequence = 0;
async function createSessionFixture(label: string, config: OpenClawConfig = {}) {
  fixtureDir ??= tempDirs.make("openclaw-code-source-projection-");
  setRuntimeConfigSnapshot(config);
  const sessionId = `${label}-${++sessionSequence}`;
  const scope = sessionTarget(path.join(fixtureDir, "sessions.json"), sessionId);
  await upsertSessionEntryCore(scope, { sessionId, updatedAt: 1 });
  const manager = SessionManager.open(scope, fixtureDir);
  const { tools, catalogRef } = createCodeModeHarness();
  registerHeadlessToolSearchCatalog({ catalogRef, tools: [] });
  return { dir: fixtureDir, scope, manager, tools };
}
afterEach(async () => {
  await resetCodeModeTestState();
  resetGlobalHookRunner();
  if (fixtureDir) {
    await drainSessionStateForTest({ stateDir: fixtureDir });
  }
});
registerAgentSessionLoopTestLifecycle();
afterEach(() => {
  clearRuntimeConfigSnapshot();
  resetDiagnosticEventsForTest();
  resetDiagnosticRunActivityForTest();
  resetSecretRedactionRegistryForTest();
});

function mockToolTurn(content: AssistantMessage["content"]) {
  streamMocks.streamSimple
    .mockImplementationOnce((model: Model) =>
      createAssistantResultStream(createAssistant(model, content, "toolUse")),
    )
    .mockImplementation((model: Model) =>
      createAssistantResultStream(createAssistant(model, "Done.")),
    );
}

function createSourceSession(
  sessionManager: SessionManager,
  tools: ReturnType<typeof createCodeModeHarness>["tools"],
  options: NonNullable<Parameters<typeof createTestSession>[0]> = {},
) {
  return createTestSession({ sessionManager, customTools: toToolDefinitions(tools), ...options });
}

function installWriteHook(handler: (message: AgentMessage) => unknown) {
  initializeGlobalHookRunner(
    createMockPluginRegistry([
      {
        hookName: "before_message_write",
        handler: (event: unknown) => handler((event as { message: AgentMessage }).message),
      },
    ]),
  );
}

function toolCall(
  id: string,
  args: Record<string, unknown>,
  name = "exec",
): Extract<AssistantMessage["content"][number], { type: "toolCall" }> {
  return { type: "toolCall", id, name, arguments: args };
}

function toolCalls(messages: AgentMessage[], id?: string) {
  return messages.flatMap((message) =>
    message.role === "assistant"
      ? message.content.filter(
          (block) => block.type === "toolCall" && (id === undefined || block.id === id),
        )
      : [],
  );
}

async function reopen(scope: Parameters<typeof SessionManager.open>[0], dir: string) {
  expect(
    await closeOpenClawAgentDatabaseByPathAsync(
      resolveSqliteTargetFromSessionStorePath(scope.storePath).path!,
    ),
  ).toBe(true);
  return SessionManager.open(scope, dir);
}

async function expectReopens(
  session: AgentSession,
  manager: SessionManager,
  scope: Parameters<typeof SessionManager.open>[0],
  dir: string,
) {
  const cached = manager.buildSessionContext();
  session.dispose();
  const reopened = await reopen(scope, dir);
  expect(reopened.buildSessionContext()).toEqual(cached);
  return reopened;
}

const source =
  "function computeToken() { return 42; }\nconst API_TOKEN = computeToken(); return API_TOKEN;";
const codeArgs = (code = source) => ({ title: "Calculate", code });
const genericLiteral = "fixture-only-not-a-real-secret";
const registeredLiteral = "fixture-registered-source-value";
const vendorLiteral = "sk-fixturesyntheticcredential1234567890";
const customLiteral = "fixture-custom-source-value";
const credentialSource = `const API_TOKEN = "${genericLiteral}"; const vendor = "${vendorLiteral}"; const registered = "${registeredLiteral}"; const custom = "${customLiteral}";\n${source.replaceAll("API_TOKEN", "OTHER_TOKEN")}`;
const sourceCases = [
  ["credential-shaped literals", { code: credentialSource }, "completed"],
  ["retired JavaScript option", { code: source, language: "javascript" }, "error"],
  ["command only", { command: source }, "validation"],
] as const;

it.each(sourceCases)(
  "preserves %s through SQLite close, reopen, and the next provider context",
  async (label, args, outcome) => {
    const config = { logging: { redactPatterns: ["fixture-custom-source-value"] } };
    const { dir, scope, manager, tools } = await createSessionFixture("source-projection", config);
    registerSecretValueForRedaction(registeredLiteral);
    guardSessionManager(manager, { config, allowedToolNames: ["exec", "wait"] });
    const originalArgs = {
      ...args,
      title: "Calculate",
      note: source,
      nested: { code: source, command: source },
      apiKey: "fixture-structured-secret",
    };
    mockToolTurn([{ type: "text", text: source }, toolCall("call_source", originalArgs)]);
    if (label === "command only") {
      expect(await tools[0]!.execute("direct_alias", { command: source })).toMatchObject({
        details: { status: "completed", value: 42 },
      });
    }
    const { session } = await createSourceSession(manager, tools);
    const model = session.agent.state.model!;
    let modelCallSeq = 0;
    session.agent.streamFn = wrapStreamFnWithDiagnosticModelCallEvents(session.agent.streamFn!, {
      runId: scope.sessionId,
      provider: model.provider,
      model: model.id,
      trace: createDiagnosticTraceContext(),
      nextCallId: () => `${scope.sessionId}:${++modelCallSeq}`,
    });
    await session.prompt("Compute the harmless number.");
    const liveResult = session.state.messages.find((message) => message.role === "toolResult");
    if (outcome === "validation") {
      expect(liveResult).toMatchObject({
        toolCallId: "call_source",
        isError: true,
        content: [{ text: expect.stringContaining("code") }],
      });
    } else {
      expect(liveResult).toMatchObject({
        toolCallId: "call_source",
        details: { status: outcome, ...(outcome === "completed" ? { value: 42 } : {}) },
      });
    }
    expect(session.state.messages.find((message) => message.role === "assistant")).toMatchObject({
      content: [{ text: source }, { arguments: originalArgs }],
    });
    const reopened = await expectReopens(session, manager, scope, dir);
    const { session: nextSession } = await createSourceSession(reopened, tools);
    await nextSession.prompt("Recall the earlier calculation.");
    const providerContext = streamMocks.streamSimple.mock.calls.at(-1)![1];
    const assistant = providerContext.messages.find((message) => message.role === "assistant");
    assert(assistant);
    expect(assistant.content).toEqual([
      { type: "text", text: source },
      toolCall("call_source", originalArgs),
    ]);
    const replayResult = providerContext.messages.find((item) => item.role === "toolResult");
    assert(replayResult);
    expect(replayResult.toolCallId).toBe("call_source");
    expect(providerContext.messages.indexOf(replayResult)).toBe(
      providerContext.messages.indexOf(assistant) + 1,
    );
  },
);

it.each(["message_end", "before_message_write"] as const)(
  "preserves hook-supplied source bytes after %s replacements",
  async (hook) => {
    const { dir, scope, manager, tools } = await createSessionFixture("source-hooks");
    registerSecretValueForRedaction(registeredLiteral);
    let action = "mutate";
    const replace = (message: AgentMessage): AgentMessage => {
      if (message.role !== "assistant" || message.stopReason !== "toolUse") {
        return message;
      }
      const call = message.content.find((block) => block.type === "toolCall");
      assert(call, "missing call");
      if (!call.id.startsWith("hook_")) {
        return message;
      }
      if (action === "mutate") {
        call.arguments.code = source.replaceAll("42", "43");
        return message;
      }
      if (action === "remove") {
        return { ...message, content: [{ type: "text", text: "Removed call." }] };
      }
      if (action === "collision") {
        return { ...message, content: [call, { ...call }] };
      }
      return {
        ...message,
        content: [{ ...call, arguments: { ...call.arguments, code: credentialSource } }],
      };
    };
    const replaceEndedMessage = async (event: unknown) => ({
      message: replace((event as MessageEndEvent).message),
    });
    const resourceLoader =
      hook === "message_end"
        ? await createResourceLoader((api) => {
            api.on("message_end", replaceEndedMessage);
          })
        : await createResourceLoader();
    if (hook === "before_message_write") {
      installWriteHook((message) => ({ message: replace(message) }));
    }
    guardSessionManager(manager, { config: {}, allowedToolNames: ["exec", "wait"] });
    const { session } = await createSourceSession(manager, tools, { resourceLoader });
    for (const nextAction of ["mutate", "replace", "remove", "collision"]) {
      action = nextAction;
      mockToolTurn([toolCall(`hook_${action}`, codeArgs())]);
      await session.prompt(`Test ${action}.`);
      const stored = toolCalls(manager.buildSessionContext().messages, `hook_${action}`);
      if (action === "remove") {
        expect(stored).toHaveLength(0);
        continue;
      }
      const expectedSource =
        action === "mutate"
          ? source.replaceAll("42", "43")
          : action === "replace"
            ? credentialSource
            : source;
      expect(stored.length).toBeGreaterThan(0);
      for (const block of stored) {
        expect(block).toMatchObject({ arguments: { code: expectedSource } });
      }
    }
    manager.appendMessage(
      createAssistant(testModel, [toolCall("late_source", { code: source })], "toolUse"),
    );
    guardSessionManager(manager).clearPendingToolResults?.();
    expect(manager.getLeafEntry()).toMatchObject({
      message: { content: [{ arguments: { code: source } }] },
    });
    await expectReopens(session, manager, scope, dir);
  },
);

it("preserves mixed tool arguments through a reentrant direct SQLite append", async () => {
  const { dir, scope, manager, tools } = await createSessionFixture("source-mixed");
  let reentrant: AgentMessage | undefined;
  installWriteHook((message) => {
    if (message.role === "assistant" && message.stopReason === "toolUse" && !reentrant) {
      const outcome = appendTranscriptMessageSync(scope, { message, eventId: "reentrant_source" });
      reentrant = outcome.ok ? outcome.value?.message : undefined;
    }
  });
  guardSessionManager(manager, { config: {}, allowedToolNames: ["exec", "wait", "other"] });
  const otherParameters = Type.Object({ code: Type.String() });
  const other: ToolDefinition<typeof otherParameters> = {
    name: "other",
    label: "Other",
    description: "Ordinary tool",
    parameters: otherParameters,
    execute: async (_id, args) => ({
      content: [{ type: "text", text: "ordinary" }],
      details: { receivedOriginal: args.code === source },
    }),
  };
  mockToolTurn([
    toolCall("mixed_rejected", {}, "unavailable"),
    toolCall("mixed_code", codeArgs()),
    toolCall("mixed_other", { code: source }, "other"),
  ]);
  const { session } = await createSourceSession(manager, tools, {
    customTools: [...toToolDefinitions(tools), other],
  });
  await session.prompt("Run both independent calls.");
  expect(session.state.messages.filter((message) => message.role === "toolResult")).toMatchObject([
    { toolCallId: "mixed_rejected", isError: true },
    { toolCallId: "mixed_code", details: { value: 42 } },
    { toolCallId: "mixed_other", details: { receivedOriginal: true } },
  ]);
  expect(reentrant).toMatchObject({
    content: [{ arguments: { code: source } }, { arguments: { code: source } }],
  });
  const stored = manager
    .getEntries()
    .filter(
      (entry) =>
        entry.type === "message" &&
        entry.message.role === "assistant" &&
        entry.message.stopReason === "toolUse",
    );
  expect(stored).toHaveLength(2);
  expect(stored[1]).toMatchObject({
    message: {
      content: [
        { id: "mixed_code", arguments: { code: source } },
        { id: "mixed_other", arguments: { code: source } },
      ],
    },
  });
  await expectReopens(session, manager, scope, dir);
});

it("preserves source across reused managers and ordinary append batches", async () => {
  const { dir, scope, manager, tools } = await createSessionFixture("source-reuse");
  const shell: ToolDefinition = {
    name: "exec",
    label: "Shell",
    description: "Ordinary shell owner",
    parameters: Type.Object({ command: Type.String() }),
    execute: async () => ({ content: [{ type: "text", text: source }], details: {} }),
  };
  for (const mode of ["code", "shell", "code"] as const) {
    guardSessionManager(manager, { config: {}, allowedToolNames: ["exec", "wait"], runId: mode });
    mockToolTurn([toolCall("reused_id", mode === "code" ? codeArgs() : { command: source })]);
    const { session } = await createSourceSession(manager, tools, {
      customTools: mode === "code" ? toToolDefinitions(tools) : [shell],
    });
    await session.prompt(`Use ${mode} mode.`);
    const latestCall = toolCalls(manager.buildSessionContext().messages).at(-1)!;
    if (latestCall.type !== "toolCall") {
      throw new Error("missing latest call");
    }
    expect(latestCall.arguments).toMatchObject({ [mode === "code" ? "code" : "command"]: source });
    session.dispose();
  }
  const input = { command: source, code: source, nested: { code: source } };
  const nested = createNestedToolActivity({
    runId: "run-test",
    scopeId: "scope-test",
    afterEntryId: null,
    startOrder: 0,
    toolCallId: "nested_shell",
    toolName: "exec",
    parentToolCallId: "reused_id",
    input: { ...input, toolKind: "code_mode_exec" },
    result: { content: [{ type: "text", text: source }], details: {} },
    isError: false,
    startedAt: 1,
    timestamp: 2,
  });
  const messages = [{ message: { ...nested, idempotencyKey: "batch_0" }, eventId: "batch_0" }];
  const first = await appendTranscriptMessages(scope, { messages });
  const repeated = await appendTranscriptMessages(scope, { messages });
  expect(first).toMatchObject([{ appended: true }]);
  expect(repeated).toMatchObject([{ appended: false, messageId: first[0]?.messageId }]);
  const reopened = await reopen(scope, dir);
  const replay = reopened.buildSessionContext().messages;
  expect(replay.some((message) => message.role === "custom")).toBe(false);
  const storedActivity = reopened.getBranch().at(-1);
  expect(storedActivity).toMatchObject({
    message: {
      details: {
        toolCallId: "nested_shell",
        parentToolCallId: "reused_id",
        input,
        result: { content: [{ text: source }] },
      },
    },
  });
});

describe("provider source fidelity", () => {
  const providerDirs = useAutoCleanupTempDirTracker((cleanup) =>
    afterEach(async () => {
      for (const dir of providerDirs.dirs) {
        await closeOpenClawAgentDatabasesAsync(dir);
      }
      cleanup();
    }),
  );
  afterEach(resetLogger);

  const textContent = (result: Pick<ToolResultMessage, "content"> | undefined) =>
    result?.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");

  it.each([
    ["anthropic-messages", "anthropic", "claude-sonnet-4-6", ".env"],
    ["openai-responses", "openai", "gpt-4.1", "fixture.txt"],
  ] as const)(
    "preserves file bytes for %s (%s/%s) after read returns %s",
    async (api, provider, id, filename) => {
      const cwd = providerDirs.make("openclaw-tool-source-fidelity-");
      const fakeSecret = "fixture-registered-secret-0123456789";
      const vendorSecret = `sk-${"fixture".repeat(6)}`;
      const benignMarker = "VISIBLE_FILE_CONTENT";
      const sourceAssignment = "API_TOKEN = computeToken()";
      registerSecretValueForRedaction(fakeSecret);
      const fileContent = `${benignMarker}\nVALUE=${fakeSecret}\n${vendorSecret}\n${sourceAssignment}\n`;
      await fs.writeFile(path.join(cwd, filename), fileContent);
      const readTool = createOpenClawReadTool(createReadTool(cwd), { cwd });
      const readControlText = textContent(
        await readTool.execute("direct-read-control", { path: filename }),
      );
      expect(readControlText).toBe(fileContent);

      const model: Model = {
        ...testModel,
        api,
        provider,
        id,
        baseUrl: "https://router.invalid",
      };
      const scope = sessionTarget(path.join(cwd, "openclaw-agent.sqlite"), "tool-source-fidelity");
      await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      const sessionManager = guardSessionManager(await SessionManager.openAsync(scope, cwd), {
        config: {},
        allowedToolNames: ["read"],
      });
      const resourceLoader = new DefaultResourceLoader({
        cwd,
        agentDir: cwd,
        extensionFactories: buildEmbeddedExtensionFactories({
          cfg: {},
          workspaceDir: cwd,
          sessionManager,
          model,
        }),
      });
      await resourceLoader.reload();
      let providerPayload: unknown;
      let liveContext: Context | undefined;
      const currentResult = () =>
        liveContext?.messages.findLast((message) => message.role === "toolResult");
      const probe = toolCall("probe-read", { path: filename }, "read");
      streamMocks.streamSimple
        .mockImplementationOnce((activeModel: Model) =>
          createAssistantResultStream(createAssistant(activeModel, [probe], "toolUse")),
        )
        .mockImplementation((_activeModel, context, options) => {
          liveContext = context;
          const capture = async (payload: unknown, requestModel: Model) => {
            const replacement = await options?.onPayload?.(payload, requestModel);
            providerPayload = replacement === undefined ? payload : replacement;
            throw new Error("synthetic probe stops before any network operation");
          };
          const probeOptions = { ...options, apiKey: "synthetic-probe-auth", onPayload: capture };
          return api === "anthropic-messages"
            ? streamAnthropic(model as Model<"anthropic-messages">, context, probeOptions)
            : streamOpenAIResponses(model as Model<"openai-responses">, context, probeOptions);
        });
      const { session } = await createTestSession({
        model,
        sessionManager,
        resourceLoader,
        customTools: toToolDefinitions([readTool]),
      });
      const previousTransform = session.agent.transformContext;
      session.agent.transformContext = async (messages, signal) =>
        normalizeMessagesForLlmBoundary(
          previousTransform
            ? await previousTransform.call(session.agent, messages, signal)
            : messages,
        );
      const removeGuard = installToolResultContextGuard({
        agent: session.agent,
        contextWindowTokens: 32_768,
      });
      try {
        await session.prompt(`Read ${filename}.`);
        const stored = JSON.stringify(sessionManager.getEntries());
        const liveToolResult = currentResult();
        const liveToolText = textContent(liveToolResult) ?? "";
        expect(liveToolResult).toMatchObject({ isError: false });
        for (const marker of [benignMarker, fakeSecret, vendorSecret]) {
          expect(JSON.stringify(providerPayload)).toContain(marker);
        }
        for (const secret of [fakeSecret, vendorSecret]) {
          expect(stored).toContain(secret);
        }
        expect(liveToolText).toBe(readControlText);
        const transcript = await SessionManager.openAsync(scope, cwd);
        const storedResult = transcript
          .getBranch()
          .findLast((entry) => entry.type === "message" && entry.message.role === "toolResult");
        expect(storedResult?.type === "message" && storedResult.message).toMatchObject({
          role: "toolResult",
          content: [{ type: "text", text: readControlText }],
        });
        await session.prompt("Continue using the previous read result.");
        expect(textContent(currentResult())).toBe(liveToolText);
      } finally {
        removeGuard();
        session.dispose();
      }
    },
  );
});
