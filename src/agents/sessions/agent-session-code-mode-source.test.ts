import assert from "node:assert/strict";
import path from "node:path";
import type { AssistantMessage, Model } from "openclaw/plugin-sdk/llm";
import { Type } from "typebox";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  appendTranscriptMessages,
  appendTranscriptMessageSync,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "../../config/sessions/session-sqlite-target.js";
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
function createSessionScope(label: string) {
  fixtureDir ??= tempDirs.make("openclaw-code-source-projection-");
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
  await drainSessionStateForTest({ stateDir: fixtureDir });
});
registerAgentSessionLoopTestLifecycle();
afterEach(() => {
  resetDiagnosticEventsForTest();
  resetDiagnosticRunActivityForTest();
  resetGlobalHookRunner();
  resetSecretRedactionRegistryForTest();
});

describe("AgentSession runtime and transcript projections", () => {
  const source =
    "function computeToken() { return 42; }\nconst API_TOKEN = computeToken(); return API_TOKEN;";
  const genericLiteral = "fixture-only-not-a-real-secret";
  const registeredLiteral = "fixture-registered-source-value";
  const vendorLiteral = "sk-fixturesyntheticcredential1234567890";
  const customLiteral = "fixture-custom-source-value";
  const credentialSource = `const API_TOKEN = "${genericLiteral}"; const vendor = "${vendorLiteral}"; const registered = "${registeredLiteral}"; const custom = "${customLiteral}";\n${source.replaceAll("API_TOKEN", "OTHER_TOKEN")}`;
  const sourceCases = [
    { label: "JavaScript code", args: { code: source }, outcome: "completed" },
    {
      label: "retired JavaScript option",
      args: { code: source, language: "javascript" },
      outcome: "error",
    },
    ...["bash", null].map((language) => ({
      label: `invalid language ${JSON.stringify(language)}`,
      args: { code: "API_TOKEN=fixtureUnquotedLiteral;", language },
      outcome: "error",
    })),
    {
      label: "retired TypeScript option",
      args: { code: source, language: "typescript" },
      outcome: "error",
    },
    { label: "command only", args: { command: source }, outcome: "validation" },
    { label: "paired aliases", args: { code: source, command: source }, outcome: "completed" },
    { label: "blank code alternate", args: { code: "", command: source }, outcome: "completed" },
    {
      label: "blank command alternate",
      args: { code: source, command: " " },
      outcome: "completed",
    },
    {
      label: "divergent aliases",
      args: { code: source, command: "const API_TOKEN = computeOtherToken(); return API_TOKEN;" },
      outcome: "error",
    },
    { label: "both blank", args: { code: " ", command: "" }, outcome: "error" },
    { label: "credential-shaped literals", args: { code: credentialSource }, outcome: "completed" },
  ];

  it.each(sourceCases)(
    "preserves $label through SQLite close, reopen, and the next provider context",
    async ({ args, outcome, label }) => {
      const { dir, scope } = createSessionScope("source-projection");
      const config = { logging: { redactPatterns: ["fixture-custom-source-value"] } };
      registerSecretValueForRedaction(registeredLiteral);
      await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      const manager = SessionManager.open(scope, dir);
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
      streamMocks.streamSimple
        .mockImplementationOnce((model: Model) =>
          createAssistantResultStream(
            createAssistant(
              model,
              [
                { type: "text", text: source },
                { type: "toolCall", id: "call_source", name: "exec", arguments: originalArgs },
              ],
              "toolUse",
            ),
          ),
        )
        .mockImplementation((model: Model) =>
          createAssistantResultStream(createAssistant(model, [{ type: "text", text: "Done." }])),
        );
      try {
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
        session.agent.streamFn = wrapStreamFnWithDiagnosticModelCallEvents(
          session.agent.streamFn!,
          {
            runId: scope.sessionId,
            provider: model.provider,
            model: model.id,
            trace: createDiagnosticTraceContext(),
            nextCallId: () => `${scope.sessionId}:${++modelCallSeq}`,
          },
        );
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
        expect(
          session.state.messages.find((message) => message.role === "assistant"),
        ).toMatchObject({ content: [{ text: source }, { arguments: originalArgs }] });
        const cached = manager.buildSessionContext();
        session.dispose();
        const databasePath = resolveSqliteTargetFromSessionStorePath(scope.storePath).path!;
        expect(await closeOpenClawAgentDatabaseByPathAsync(databasePath)).toBe(true);
        const reopened = SessionManager.open(scope, dir);
        expect(reopened.buildSessionContext()).toEqual(cached);
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
      } finally {
        await resetCodeModeTestState();
      }
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
      const cases = [
        "unchanged",
        "clone",
        "mutate-source",
        "default-to-javascript",
        "javascript-to-default",
        "change-dialect",
        "unsupported-dialect",
        "malformed-dialect",
        "rename",
        "remove",
        "collision",
        "replace-with-literal",
      ] as const;
      let action: (typeof cases)[number] = "unchanged";
      let original: AssistantMessage | undefined;
      const replace = (message: AgentMessage): AgentMessage => {
        if (message.role !== "assistant" || message.stopReason !== "toolUse") {
          return message;
        }
        const call = message.content.find((block) => block.type === "toolCall")!;
        if (call.type !== "toolCall") {
          throw new Error("missing call");
        }
        if (!call.id.startsWith("hook_")) {
          return message;
        }
        switch (action) {
          case "clone":
            return { ...message, content: [{ ...call }] };
          case "mutate-source":
            call.arguments.code = source.replaceAll("42", "43");
            return message;
          case "default-to-javascript":
            call.arguments.language = "javascript";
            return message;
          case "javascript-to-default":
            delete call.arguments.language;
            return message;
          case "change-dialect":
            call.arguments.language = "typescript";
            return message;
          case "unsupported-dialect":
            call.arguments.language = "bash";
            return message;
          case "malformed-dialect":
            call.arguments.language = null;
            return message;
          case "rename":
            call.name = "other";
            return message;
          case "remove":
            return { ...message, content: [{ type: "text", text: "Removed call." }] };
          case "collision":
            return { ...message, content: [call, { ...call }] };
          case "replace-with-literal":
            return {
              ...message,
              content: [
                {
                  ...call,
                  arguments: { title: "Compute the harmless number", code: credentialSource },
                },
              ],
            };
          default:
            return { ...message, content: [{ type: "text", text: "Hook preserved call." }, call] };
        }
      };
      const resourceLoader =
        hook === "message_end"
          ? createResourceLoader(
              new Map([
                [
                  "message_end",
                  [
                    async (event: unknown) => ({
                      message: replace((event as MessageEndEvent).message),
                    }),
                  ],
                ],
              ]),
            )
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
      await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      const manager = SessionManager.open(scope, dir);
      guardSessionManager(manager, { config: {}, allowedToolNames: ["exec", "wait", "other"] });
      const { session } = await createTestSession({
        sessionManager: manager,
        customTools: [...toToolDefinitions(tools), other],
        resourceLoader,
      });
      try {
        for (const nextAction of cases) {
          action = nextAction;
          streamMocks.streamSimple
            .mockImplementationOnce((model: Model) => {
              original = createAssistant(
                model,
                [
                  {
                    type: "toolCall",
                    id: `hook_${action}`,
                    name: "exec",
                    arguments: {
                      title: "Compute the harmless number",
                      code: source,
                      ...(action === "javascript-to-default" ? { language: "javascript" } : {}),
                    },
                  },
                ],
                "toolUse",
              );
              return createAssistantResultStream(original);
            })
            .mockImplementation((model: Model) =>
              createAssistantResultStream(
                createAssistant(model, [{ type: "text", text: "Done." }]),
              ),
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
          late.content = [
            { type: "toolCall", id: `late_${action}`, name: "exec", arguments: { code: source } },
          ];
          manager.appendMessage(late);
          guardSessionManager(manager).clearPendingToolResults?.();
          const lateStored = manager.getLeafEntry();
          expect(lateStored).toMatchObject({
            message: {
              content: [{ arguments: { code: source } }],
            },
          });
        }
        const cached = manager.buildSessionContext();
        session.dispose();
        expect(
          await closeOpenClawAgentDatabaseByPathAsync(
            resolveSqliteTargetFromSessionStorePath(scope.storePath).path!,
          ),
        ).toBe(true);
        expect(SessionManager.open(scope, dir).buildSessionContext()).toEqual(cached);
      } finally {
        await resetCodeModeTestState();
        resetGlobalHookRunner();
      }
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
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    const manager = SessionManager.open(scope, dir);
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
    streamMocks.streamSimple
      .mockImplementationOnce((model: Model) =>
        createAssistantResultStream(
          createAssistant(
            model,
            [
              { type: "toolCall", id: "mixed_rejected", name: "unavailable", arguments: {} },
              {
                type: "toolCall",
                id: "mixed_code",
                name: "exec",
                arguments: { title: "Compute the harmless number", code: source },
              },
              { type: "toolCall", id: "mixed_other", name: "other", arguments: { code: source } },
            ],
            "toolUse",
          ),
        ),
      )
      .mockImplementation((model: Model) =>
        createAssistantResultStream(createAssistant(model, [{ type: "text", text: "Done." }])),
      );
    try {
      const { session } = await createTestSession({
        sessionManager: manager,
        customTools: [...toToolDefinitions(tools), other],
      });
      await session.prompt("Run both independent calls.");
      expect(streamMocks.streamSimple).toHaveBeenCalledTimes(2);
      expect(
        session.state.messages.filter((message) => message.role === "toolResult"),
      ).toMatchObject([
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
            {
              id: "mixed_other",
              arguments: { code: source },
            },
          ],
        },
      });
      const cached = manager.buildSessionContext();
      session.dispose();
      expect(
        await closeOpenClawAgentDatabaseByPathAsync(
          resolveSqliteTargetFromSessionStorePath(scope.storePath).path!,
        ),
      ).toBe(true);
      expect(SessionManager.open(scope, dir).buildSessionContext()).toEqual(cached);
    } finally {
      resetGlobalHookRunner();
      await resetCodeModeTestState();
    }
  });

  it("preserves source across reused managers and ordinary append batches", async () => {
    const { dir, scope } = createSessionScope("source-reuse");
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    const manager = SessionManager.open(scope, dir);
    const { tools, catalogRef } = createCodeModeHarness();
    registerHeadlessToolSearchCatalog({ catalogRef, tools: [] });
    const shell: ToolDefinition = {
      name: "exec",
      label: "Shell",
      description: "Ordinary shell owner",
      parameters: Type.Object({ command: Type.String() }),
      execute: async () => ({ content: [{ type: "text", text: source }], details: {} }),
    };
    try {
      for (const mode of ["code", "shell", "code"] as const) {
        guardSessionManager(manager, {
          config: {},
          allowedToolNames: ["exec", "wait"],
          runId: mode,
        });
        streamMocks.streamSimple
          .mockImplementationOnce((model: Model) =>
            createAssistantResultStream(
              createAssistant(
                model,
                [
                  {
                    type: "toolCall",
                    id: "reused_id",
                    name: "exec",
                    arguments:
                      mode === "code"
                        ? { title: "Compute the harmless number", code: source }
                        : { command: source },
                  },
                ],
                "toolUse",
              ),
            ),
          )
          .mockImplementation((model: Model) =>
            createAssistantResultStream(createAssistant(model, [{ type: "text", text: "Done." }])),
          );
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
        if (mode === "code") {
          expect(latestCall.arguments.code).toBe(source);
        } else {
          expect(latestCall.arguments.command).toBe(source);
        }
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
    } finally {
      await resetCodeModeTestState();
    }
  });
});
