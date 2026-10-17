import assert from "node:assert/strict";
import path from "node:path";
import type { AssistantMessage, Model } from "openclaw/plugin-sdk/llm";
import { Type } from "typebox";
import { afterAll, afterEach, expect, it } from "vitest";
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
import { registerSecretValueForRedaction } from "../../logging/secret-redaction-registry.js";
import { resetSecretRedactionRegistryForTest } from "../../logging/secret-redaction-registry.test-support.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../../plugins/hooks.test-helpers.js";
import { createNestedToolActivity } from "../../sessions/nested-tool-activity.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../../state/openclaw-agent-db.js";
import {
  cleanupSessionStateForTest,
  drainSessionStateForTest,
} from "../../test-utils/session-state-cleanup.js";
import { toToolDefinitions } from "../agent-tool-definition-adapter.js";
import { createCodeModeHarness, resetCodeModeTestState } from "../code-mode.test-support.js";
import { wrapStreamFnWithDiagnosticModelCallEvents } from "../embedded-agent-runner/run/attempt.model-diagnostic-events.js";
import type { AgentMessage } from "../runtime/index.js";
import { guardSessionManager } from "../session-tool-result-guard-wrapper.js";
import { registerHeadlessToolSearchCatalog } from "../tool-search.js";
import {
  createAssistant,
  createAssistantResultStream,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
} from "./agent-session-loop-correctness.test-support.js";
import { createResourceLoader } from "./agent-session-loop-resource-loader.test-support.js";
import type { AgentSession } from "./agent-session.js";
import type { MessageEndEvent, ToolDefinition } from "./extensions/types.js";
import { SessionManager } from "./session-manager.js";

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
function createSessionScope(label: string, config: OpenClawConfig = {}) {
  fixtureDir ??= tempDirs.make("openclaw-code-source-projection-");
  setRuntimeConfigSnapshot(config);
  const sessionId = `${label}-${++sessionSequence}`;
  return {
    dir: fixtureDir,
    scope: {
      agentId: "main",
      sessionId,
      sessionKey: `agent:main:${sessionId}`,
      storePath: path.join(fixtureDir, "sessions.json"),
    },
  };
}
afterEach(async () => {
  await resetCodeModeTestState();
  resetGlobalHookRunner();
  await drainSessionStateForTest({ stateDir: fixtureDir });
});
registerAgentSessionLoopTestLifecycle();
afterEach(() => {
  clearRuntimeConfigSnapshot();
  resetDiagnosticEventsForTest();
  resetDiagnosticRunActivityForTest();
  resetSecretRedactionRegistryForTest();
});

function mockToolTurn(
  content: AssistantMessage["content"],
  capture?: (message: AssistantMessage) => void,
) {
  streamMocks.streamSimple
    .mockImplementationOnce((model: Model) => {
      const message = createAssistant(model, content, "toolUse");
      capture?.(message);
      return createAssistantResultStream(message);
    })
    .mockImplementation((model: Model) =>
      createAssistantResultStream(createAssistant(model, "Done.")),
    );
}

function toolCall(
  id: string,
  args: Record<string, unknown>,
  name = "exec",
): Extract<AssistantMessage["content"][number], { type: "toolCall" }> {
  return { type: "toolCall", id, name, arguments: args };
}

async function openManager(scope: Parameters<typeof SessionManager.open>[0], dir: string) {
  await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
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
  expect(
    await closeOpenClawAgentDatabaseByPathAsync(
      resolveSqliteTargetFromSessionStorePath(scope.storePath).path!,
    ),
  ).toBe(true);
  const reopened = SessionManager.open(scope, dir);
  expect(reopened.buildSessionContext()).toEqual(cached);
  return reopened;
}

const source =
  "function computeToken() { return 42; }\nconst API_TOKEN = computeToken(); return API_TOKEN;";
const genericLiteral = "fixture-only-not-a-real-secret";
const registeredLiteral = "fixture-registered-source-value";
const vendorLiteral = "sk-fixturesyntheticcredential1234567890";
const customLiteral = "fixture-custom-source-value";
const credentialSource = `const API_TOKEN = "${genericLiteral}"; const vendor = "${vendorLiteral}"; const registered = "${registeredLiteral}"; const custom = "${customLiteral}";\n${source.replaceAll("API_TOKEN", "OTHER_TOKEN")}`;
const sourceCase = <T extends Record<string, unknown>>(
  label: string,
  args: T,
  outcome = "completed",
) => ({ label, args, outcome });
const sourceCases = [
  sourceCase("JavaScript code", { code: source }),
  sourceCase("retired JavaScript option", { code: source, language: "javascript" }, "error"),
  ...["bash", null].map((language) =>
    sourceCase(
      `invalid language ${JSON.stringify(language)}`,
      { code: "API_TOKEN=fixtureUnquotedLiteral;", language },
      "error",
    ),
  ),
  sourceCase("retired TypeScript option", { code: source, language: "typescript" }, "error"),
  sourceCase("command only", { command: source }, "validation"),
  sourceCase("paired aliases", { code: source, command: source }),
  sourceCase("blank code alternate", { code: "", command: source }),
  sourceCase("blank command alternate", { code: source, command: " " }),
  sourceCase(
    "divergent aliases",
    { code: source, command: "const API_TOKEN = computeOtherToken(); return API_TOKEN;" },
    "error",
  ),
  sourceCase("both blank", { code: " ", command: "" }, "error"),
  sourceCase("credential-shaped literals", { code: credentialSource }),
];

it.each(sourceCases)(
  "preserves $label through SQLite close, reopen, and the next provider context",
  async ({ args, outcome, label }) => {
    const config = { logging: { redactPatterns: ["fixture-custom-source-value"] } };
    const { dir, scope } = createSessionScope("source-projection", config);
    registerSecretValueForRedaction(registeredLiteral);
    const manager = await openManager(scope, dir);
    guardSessionManager(manager, { config, allowedToolNames: ["exec", "wait"] });
    const originalArgs = {
      ...args,
      title: "Compute the harmless number",
      note: source,
      nested: { code: source, command: source },
      apiKey: "fixture-structured-secret",
    };
    const { tools, catalogRef } = createCodeModeHarness();
    registerHeadlessToolSearchCatalog({ catalogRef, tools: [] });
    mockToolTurn([{ type: "text", text: source }, toolCall("call_source", originalArgs)]);
    if (label === "command only") {
      expect(await tools[0]!.execute("direct_alias", { command: source })).toMatchObject({
        details: { status: "completed", value: 42 },
      });
    }
    const { session } = await createTestSession({
      sessionManager: manager,
      customTools: toToolDefinitions(tools),
    });
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
    expect(streamMocks.streamSimple).toHaveBeenCalledTimes(2);
    const liveResult = session.state.messages.find((message) => message.role === "toolResult");
    expect(liveResult).toMatchObject({ toolCallId: "call_source" });
    if (outcome === "validation") {
      expect(liveResult).toMatchObject({
        isError: true,
        content: [
          {
            text: expect.stringContaining(
              label.startsWith("invalid language") ? "language" : "code",
            ),
          },
        ],
      });
    } else {
      expect(liveResult).toMatchObject({
        details: { status: outcome, ...(outcome === "completed" ? { value: 42 } : {}) },
      });
    }
    expect(session.state.messages.find((message) => message.role === "assistant")).toMatchObject({
      content: [{ text: source }, { arguments: originalArgs }],
    });
    const reopened = await expectReopens(session, manager, scope, dir);
    const { session: nextSession } = await createTestSession({
      sessionManager: reopened,
      customTools: toToolDefinitions(tools),
    });
    await nextSession.prompt("Recall the earlier calculation.");
    const providerContext = streamMocks.streamSimple.mock.calls.at(-1)![1];
    const assistant = providerContext.messages.find((message) => message.role === "assistant");
    expect(assistant).toMatchObject({
      content: [
        { text: source },
        { type: "toolCall", id: "call_source", name: "exec", arguments: originalArgs },
      ],
    });
    assert(assistant?.content[1]?.type === "toolCall");
    expect(assistant.content[1].arguments).toEqual(originalArgs);
    const replayResult = providerContext.messages.find((item) => item.role === "toolResult");
    assert(replayResult);
    expect(replayResult.toolCallId).toBe(assistant.content[1].id);
    expect(providerContext.messages.indexOf(replayResult)).toBe(
      providerContext.messages.indexOf(assistant) + 1,
    );
  },
);

it.each(["message_end", "before_message_write"] as const)(
  "preserves hook-supplied source bytes after %s replacements",
  async (hook) => {
    const { dir, scope } = createSessionScope("source-hooks");
    const { tools, catalogRef } = createCodeModeHarness();
    registerHeadlessToolSearchCatalog({ catalogRef, tools: [] });
    const other: ToolDefinition = {
      name: "other",
      label: "Other",
      description: "Ordinary JSON tool",
      parameters: Type.Object({ code: Type.String() }),
      execute: async () => ({ content: [{ type: "text", text: "ordinary" }], details: {} }),
    };
    type Change = (message: AssistantMessage, call: ReturnType<typeof toolCall>) => AgentMessage;
    const withArgs =
      (args: Record<string, unknown>): Change =>
      (message, call) => {
        Object.assign(call.arguments, args);
        return message;
      };
    const changes: Record<string, Change> = {
      unchanged: (message, call) => ({
        ...message,
        content: [{ type: "text", text: "Hook preserved call." }, call],
      }),
      clone: (message, call) => ({ ...message, content: [{ ...call }] }),
      "mutate-source": withArgs({ code: source.replaceAll("42", "43") }),
      "default-to-javascript": withArgs({ language: "javascript" }),
      "javascript-to-default": (message, call) => {
        delete call.arguments.language;
        return message;
      },
      "change-dialect": withArgs({ language: "typescript" }),
      "unsupported-dialect": withArgs({ language: "bash" }),
      "malformed-dialect": withArgs({ language: null }),
      rename: (message, call) => {
        call.name = "other";
        return message;
      },
      remove: (message) => ({ ...message, content: [{ type: "text", text: "Removed call." }] }),
      collision: (message, call) => ({ ...message, content: [call, { ...call }] }),
      "replace-with-literal": (message, call) => ({
        ...message,
        content: [
          { ...call, arguments: { title: "Compute the harmless number", code: credentialSource } },
        ],
      }),
    };
    let action = "unchanged";
    let change = changes.unchanged!;
    let original: AssistantMessage | undefined;
    const replace = (message: AgentMessage): AgentMessage => {
      if (message.role !== "assistant" || message.stopReason !== "toolUse") {
        return message;
      }
      const call = message.content.find((block) => block.type === "toolCall");
      assert(call, "missing call");
      if (!call.id.startsWith("hook_")) {
        return message;
      }
      return change(message, call);
    };
    const replaceEndedMessage = async (event: unknown) => ({
      message: replace((event as MessageEndEvent).message),
    });
    const resourceLoader =
      hook === "message_end"
        ? createResourceLoader(new Map([["message_end", [replaceEndedMessage]]]))
        : createResourceLoader();
    if (hook === "before_message_write") {
      initializeGlobalHookRunner(
        createMockPluginRegistry([
          {
            hookName: hook,
            handler: (event: unknown) => ({
              message: replace((event as { message: AgentMessage }).message),
            }),
          },
        ]),
      );
    }
    const manager = await openManager(scope, dir);
    guardSessionManager(manager, { config: {}, allowedToolNames: ["exec", "wait", "other"] });
    const { session } = await createTestSession({
      sessionManager: manager,
      customTools: [...toToolDefinitions(tools), other],
      resourceLoader,
    });
    for (const [nextAction, transform] of Object.entries(changes)) {
      action = nextAction;
      change = transform;
      mockToolTurn(
        [
          toolCall(`hook_${action}`, {
            title: "Compute the harmless number",
            code: source,
            ...(action === "javascript-to-default" ? { language: "javascript" } : {}),
          }),
        ],
        (message) => {
          original = message;
        },
      );
      await session.prompt(`Test ${action}.`);
      const stored = manager
        .buildSessionContext()
        .messages.flatMap((message) =>
          message.role === "assistant"
            ? message.content.filter(
                (block) => block.type === "toolCall" && block.id === `hook_${action}`,
              )
            : [],
        );
      if (action === "remove") {
        expect(stored).toHaveLength(0);
        continue;
      }
      expect(stored.length).toBeGreaterThan(0);
      for (const block of stored) {
        if (block.type !== "toolCall") {
          throw new Error("unexpected stored block");
        }
        const expectedSource =
          action === "mutate-source"
            ? source.replaceAll("42", "43")
            : action === "replace-with-literal"
              ? credentialSource
              : source;
        expect(block.arguments.code).toBe(expectedSource);
      }
      // A later ordinary append has the same source fidelity as a live model response.
      const late = structuredClone(original!);
      late.content = [toolCall(`late_${action}`, { code: source })];
      manager.appendMessage(late);
      guardSessionManager(manager).clearPendingToolResults?.();
      const lateStored = manager.getLeafEntry();
      expect(lateStored).toMatchObject({
        message: { content: [{ arguments: { code: source } }] },
      });
    }
    await expectReopens(session, manager, scope, dir);
  },
);

it("preserves mixed tool arguments through a reentrant direct SQLite append", async () => {
  const { dir, scope } = createSessionScope("source-mixed");
  const { tools, catalogRef } = createCodeModeHarness();
  registerHeadlessToolSearchCatalog({ catalogRef, tools: [] });
  let reentrant: AgentMessage | undefined;
  initializeGlobalHookRunner(
    createMockPluginRegistry([
      {
        hookName: "before_message_write",
        handler: (event: unknown) => {
          const { message } = event as { message: AgentMessage };
          if (message.role === "assistant" && message.stopReason === "toolUse" && !reentrant) {
            // A direct append during the hook must preserve the same source bytes.
            const outcome = appendTranscriptMessageSync(scope, {
              message,
              eventId: "reentrant_source",
            });
            reentrant = outcome.ok ? outcome.value?.message : undefined;
          }
        },
      },
    ]),
  );
  const manager = await openManager(scope, dir);
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
    toolCall("mixed_code", { title: "Compute the harmless number", code: source }),
    toolCall("mixed_other", { code: source }, "other"),
  ]);
  const { session } = await createTestSession({
    sessionManager: manager,
    customTools: [...toToolDefinitions(tools), other],
  });
  await session.prompt("Run both independent calls.");
  expect(streamMocks.streamSimple).toHaveBeenCalledTimes(2);
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
  const { dir, scope } = createSessionScope("source-reuse");
  const manager = await openManager(scope, dir);
  const { tools, catalogRef } = createCodeModeHarness();
  registerHeadlessToolSearchCatalog({ catalogRef, tools: [] });
  const shell: ToolDefinition = {
    name: "exec",
    label: "Shell",
    description: "Ordinary shell owner",
    parameters: Type.Object({ command: Type.String() }),
    execute: async () => ({ content: [{ type: "text", text: source }], details: {} }),
  };
  for (const mode of ["code", "shell", "code"] as const) {
    guardSessionManager(manager, {
      config: {},
      allowedToolNames: ["exec", "wait"],
      runId: mode,
    });
    mockToolTurn([
      toolCall(
        "reused_id",
        mode === "code"
          ? { title: "Compute the harmless number", code: source }
          : { command: source },
      ),
    ]);
    const { session } = await createTestSession({
      sessionManager: manager,
      customTools: mode === "code" ? toToolDefinitions(tools) : [shell],
    });
    await session.prompt(`Use ${mode} mode.`);
    const latestCall = manager
      .buildSessionContext()
      .messages.flatMap((message) =>
        message.role === "assistant"
          ? message.content.filter((block) => block.type === "toolCall")
          : [],
      )
      .at(-1)!;
    if (latestCall.type !== "toolCall") {
      throw new Error("missing latest call");
    }
    expect(latestCall.arguments).toMatchObject({ [mode === "code" ? "code" : "command"]: source });
    session.dispose();
  }
  const nested = [
    createNestedToolActivity({
      runId: "run-test",
      scopeId: "scope-test",
      afterEntryId: null,
      startOrder: 0,
      toolCallId: "nested_shell",
      toolName: "exec",
      parentToolCallId: "reused_id",
      input: {
        command: source,
        code: source,
        nested: { code: source },
        toolKind: "code_mode_exec",
      },
      result: { content: [{ type: "text", text: source }], details: {} },
      isError: false,
      startedAt: 1,
      timestamp: 2,
    }),
  ];
  const messages = nested.map((message, index) => ({
    message: { ...message, idempotencyKey: `batch_${index}` },
    eventId: `batch_${index}`,
  }));
  const first = await appendTranscriptMessages(scope, { messages });
  const repeated = await appendTranscriptMessages(scope, { messages });
  expect(first.every((result) => result.appended)).toBe(true);
  expect(repeated.every((result) => !result.appended)).toBe(true);
  expect(repeated.map((result) => result.messageId)).toEqual(
    first.map((result) => result.messageId),
  );
  expect(
    await closeOpenClawAgentDatabaseByPathAsync(
      resolveSqliteTargetFromSessionStorePath(scope.storePath).path!,
    ),
  ).toBe(true);
  const replay = SessionManager.open(scope, dir).buildSessionContext().messages;
  expect(replay.some((message) => message.role === "custom")).toBe(false);
  const storedActivity = SessionManager.open(scope, dir).getBranch().at(-1);
  expect(storedActivity).toMatchObject({
    message: {
      details: {
        toolCallId: "nested_shell",
        parentToolCallId: "reused_id",
        input: {
          command: source,
          code: source,
          nested: { code: source },
        },
        result: {
          content: [{ text: source }],
        },
      },
    },
  });
});
