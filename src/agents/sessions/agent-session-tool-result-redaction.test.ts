import fs from "node:fs/promises";
import path from "node:path";
import { streamAnthropic } from "@openclaw/ai/internal/anthropic";
import { streamOpenAIResponses } from "@openclaw/ai/internal/openai";
import {
  createAssistantMessageEventStream,
  type Context,
  type Model,
} from "openclaw/plugin-sdk/llm";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { readTranscriptEventRows } from "../../config/sessions/session-accessor.sqlite-read.js";
import { resolveSqliteTargetFromSessionStorePath } from "../../config/sessions/session-sqlite-target.js";
import { applyLoggingConfig, resetLogger } from "../../logging/logger.js";
import { registerSecretValueForRedaction } from "../../logging/secret-redaction-registry.js";
import { resetSecretRedactionRegistryForTest } from "../../logging/secret-redaction-registry.test-support.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { toToolDefinitions } from "../agent-tool-definition-adapter.js";
import { createOpenClawReadTool } from "../agent-tools.read.js";
import { createExecTool } from "../bash-tools.exec-run.js";
import { buildEmbeddedExtensionFactories } from "../embedded-agent-runner/extensions.js";
import { createEmbeddedAgentResourceLoader } from "../embedded-agent-runner/resource-loader.js";
import { normalizeMessagesForLlmBoundary } from "../embedded-agent-runner/run/attempt-llm-boundary.js";
import { installToolResultContextGuard } from "../embedded-agent-runner/tool-result-context-guard.js";
import { guardSessionManager } from "../session-tool-result-guard-wrapper.js";
import {
  createAssistant,
  createAssistantResultStream,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
  testModel,
} from "./agent-session-loop-correctness.test-support.js";
import { AuthStorage } from "./auth-storage.js";
import { ModelRegistry } from "./model-registry.js";
import { createAgentSession } from "./sdk.js";
import type { SessionMessageEntry } from "./session-manager-types.js";
import { SessionManager } from "./session-manager.js";
import { SettingsManager } from "./settings-manager.js";
import { createReadTool } from "./tools/read.js";

registerAgentSessionLoopTestLifecycle();
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    for (const dir of tempDirs.dirs) {
      await closeOpenClawAgentDatabasesAsync(dir);
    }
    cleanup();
  }),
);
afterEach(resetSecretRedactionRegistryForTest);
afterEach(resetLogger);

describe("AgentSession model-visible tool-result redaction", () => {
  it.each(["sync", "async"] as const)(
    "reprojects %s tool text after commit when settlement registers a new secret",
    async (mode) => {
      const cwd = tempDirs.make("openclaw-post-commit-redaction-");
      const scope = {
        agentId: "main",
        sessionId: "post-commit-redaction",
        sessionKey: "agent:main:post-commit-redaction",
        storePath: path.join(cwd, "openclaw-agent.sqlite"),
      };
      const marker = "postcommitabcdefghijklmnopqrst";
      const rawText = `VISIBLE ${marker}`;
      const maskedText = "VISIBLE postco…qrst";
      await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      const manager = guardSessionManager(await SessionManager.openAsync(scope, cwd), {
        config: {},
      });
      const database = openOpenClawAgentDatabase({ agentId: scope.agentId, path: scope.storePath });
      let committed: SessionMessageEntry | undefined;
      let committedRow: ReturnType<typeof readTranscriptEventRows>[number] | undefined;
      let providerContent: unknown;
      let terminalContent: unknown;
      streamMocks.streamSimple
        .mockImplementationOnce((model) => {
          const toolCall = {
            type: "toolCall" as const,
            id: "settled-lookup",
            name: "lookup",
            arguments: {},
            ...(mode === "async" ? { async: true as const } : {}),
          };
          const message = createAssistant(model, [toolCall], mode === "async" ? "stop" : "toolUse");
          if (mode === "sync") {
            return createAssistantResultStream(message);
          }
          const response = createAssistantMessageEventStream();
          response.push({ type: "start", partial: createAssistant(model, []) });
          response.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: message });
          response.push({ type: "done", reason: "stop", message });
          response.end();
          return response;
        })
        .mockImplementation((model: Model, context: Context) => {
          providerContent = context.messages.findLast(
            (message) => message.role === "toolResult",
          )?.content;
          return createAssistantResultStream(
            createAssistant(model, [{ type: "text", text: "Lookup complete." }]),
          );
        });
      const { session } = await createTestSession({
        sessionManager: manager,
        customTools: toToolDefinitions([
          {
            name: "lookup",
            label: "Lookup",
            description: "Return synthetic lookup text.",
            parameters: Type.Object({}),
            execute: async () => ({ content: [{ type: "text", text: rawText }], details: {} }),
          },
        ]),
        withSessionWriteSettlement: async (run) => {
          const result = await run();
          const entry = manager.getLeafEntry();
          if (!committed && entry?.type === "message" && entry.message.role === "toolResult") {
            committed = entry;
            committedRow = readTranscriptEventRows(database, scope.sessionId).at(-1);
            expect(entry.message.content).toEqual([{ type: "text", text: rawText }]);
            expect(Object.isFrozen(entry.message)).toBe(true);
            expect(Object.isFrozen(entry.message.content)).toBe(true);
            registerSecretValueForRedaction(marker);
          }
          return result;
        },
      });
      session.subscribe((event) => {
        if (event.type === "agent_end") {
          terminalContent = event.messages.findLast(
            (message) => message.role === "toolResult",
          )?.content;
        }
      });
      try {
        await session.prompt("Run lookup.");
        expect(streamMocks.streamSimple).toHaveBeenCalledTimes(2);
        expect(providerContent).toEqual([{ type: "text", text: maskedText }]);
        expect(terminalContent).toEqual(providerContent);
        expect(
          session.agent.state.messages.findLast((message) => message.role === "toolResult")
            ?.content,
        ).toEqual(providerContent);
        expect(session.agent.state.errorMessage).toBeUndefined();
        expect(session.messages.at(-1)).toMatchObject({
          role: "assistant",
          content: [{ type: "text", text: "Lookup complete." }],
          stopReason: "stop",
        });
        expect(committed).toBeDefined();
        expect(manager.getEntry(committed!.id)).toBe(committed);
        expect(committed!.message).toHaveProperty("content", [{ type: "text", text: rawText }]);
        expect(Object.isFrozen(committed!.message)).toBe(true);
        expect(committedRow).toBeDefined();
        expect(
          readTranscriptEventRows(database, scope.sessionId).find(
            (row) => row.seq === committedRow!.seq,
          ),
        ).toEqual(committedRow);
      } finally {
        session.dispose();
      }
    },
  );

  it.each([
    { kind: "opaque", ambientPolicy: "different", callbackChange: "none" },
    { kind: "opaque", ambientPolicy: "absent", callbackChange: "none" },
    { kind: "opaque", ambientPolicy: "matching", callbackChange: "duplicate" },
    { kind: "opaque", ambientPolicy: "matching", callbackChange: "late" },
    { kind: "opaque", ambientPolicy: "matching", callbackChange: "pattern" },
    { kind: "app-password", ambientPolicy: "absent", callbackChange: "none" },
  ] as const)(
    "masks $kind in first and reopened payloads (ambient=$ambientPolicy, callback=$callbackChange)",
    async ({ kind, ambientPolicy, callbackChange }) => {
      const cwd = tempDirs.make("openclaw-tool-redaction-restore-");
      const scope = {
        agentId: "main",
        sessionId: "redaction-restore",
        sessionKey: "agent:main:redaction-restore",
        storePath: path.join(cwd, "sessions.json"),
      };
      const isAppPassword = kind === "app-password";
      const config = {
        logging: { redactPatterns: isAppPassword ? [] : [String.raw`/opaque\(([^)]+)\)/g`] },
      };
      applyLoggingConfig(
        ambientPolicy === "matching"
          ? config.logging
          : ambientPolicy === "different"
            ? { redactPatterns: [String.raw`/public\(([^)]+)\)/g`] }
            : {},
      );
      const secret = isAppPassword ? "abcd-efgh-ijkl-mnop" : "abcdefghijklmnopqrst";
      const benignText =
        "public(uvwxyz0123456789abcdef) main-test-case-name token = timeObserverToken";
      const unchangedSecret = "unchanged-registry-value";
      if (callbackChange === "duplicate") {
        registerSecretValueForRedaction(unchangedSecret);
      }
      const classifiedByCallback = callbackChange === "late" || callbackChange === "pattern";
      const label = classifiedByCallback ? "unclassified" : "opaque";
      const rawValue = isAppPassword ? `standalone app password ${secret}` : `${label}(${secret})`;
      const maskedValue = isAppPassword
        ? "standalone app password abcd-e…mnop"
        : `${label}(abcdef…qrst)`;
      const rawText = `${rawValue} ${benignText}`;
      const maskedText = `${maskedValue} ${benignText}`;
      await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      const manager = guardSessionManager(SessionManager.open(scope, cwd), { config });
      const customTools = toToolDefinitions([
        {
          name: "lookup",
          label: "Lookup",
          description: "Return a synthetic lookup result.",
          parameters: Type.Object({}),
          execute: async () => ({
            content: [{ type: "text", text: rawText, apiKey: "private" }],
            details: {},
          }),
        },
      ]);
      let listenerToolText: string | undefined;
      let currentToolText: string | undefined;
      let providerPayload: unknown;
      streamMocks.streamSimple
        .mockImplementationOnce((model) =>
          createAssistantResultStream(
            createAssistant(
              model,
              [{ type: "toolCall", id: "lookup-call", name: "lookup", arguments: {} }],
              "toolUse",
            ),
          ),
        )
        .mockImplementation((model, context, options) => {
          const result = context.messages.findLast(
            (message: { role: string }) => message.role === "toolResult",
          );
          expect(result?.isError).toBe(false);
          currentToolText = result?.content.find(
            (block: { type: string }) => block.type === "text",
          )?.text;
          return streamOpenAIResponses(model as Model<"openai-responses">, context, {
            ...options,
            apiKey: "synthetic-probe-auth",
            onPayload: async (payload, requestModel) => {
              const replacement = await options?.onPayload?.(payload, requestModel);
              providerPayload = replacement === undefined ? payload : replacement;
              throw new Error("synthetic probe stops before any network operation");
            },
          });
        });
      const { session } = await createTestSession({ sessionManager: manager, customTools });
      session.subscribe((event) => {
        if (event.type === "message_end" && event.message.role === "toolResult") {
          listenerToolText = event.message.content.find((block) => block.type === "text")?.text;
          if (callbackChange === "late") {
            registerSecretValueForRedaction(secret);
          } else if (callbackChange === "duplicate") {
            registerSecretValueForRedaction(unchangedSecret);
          } else if (callbackChange === "pattern") {
            config.logging.redactPatterns.push(String.raw`/unclassified\(([^)]+)\)/g`);
          }
        }
      });
      try {
        await session.prompt("Run lookup.");
        const admittedText = currentToolText;
        expect.soft(listenerToolText === (classifiedByCallback ? rawText : maskedText)).toBe(true);
        expect.soft(admittedText === maskedText).toBe(true);
        expect(providerPayload).toBeDefined();
        expect.soft(JSON.stringify(providerPayload).includes(maskedText)).toBe(true);
        expect.soft(JSON.stringify(providerPayload).includes(secret)).toBe(false);
        session.dispose();
        const databasePath = resolveSqliteTargetFromSessionStorePath(scope.storePath).path;
        expect(await closeOpenClawAgentDatabaseByPathAsync(databasePath)).toBe(true);
        const reopened = SessionManager.open(scope, cwd);
        const { session: restored } = await createTestSession({
          sessionManager: guardSessionManager(reopened, { config }),
          customTools,
        });
        providerPayload = undefined;
        await restored.prompt("Use the earlier lookup result.");
        expect(currentToolText === maskedText).toBe(true);
        expect(providerPayload).toBeDefined();
        expect(JSON.stringify(providerPayload).includes(maskedText)).toBe(true);
        expect(JSON.stringify(providerPayload).includes(secret)).toBe(false);
        expect(currentToolText === admittedText).toBe(true);
      } finally {
        session.dispose();
        await closeOpenClawAgentDatabaseByPathAsync(
          resolveSqliteTargetFromSessionStorePath(scope.storePath).path,
        );
      }
    },
  );

  it.each([
    ["anthropic-messages", "read", ".env"],
    ["openai-responses", "read", "fixture.txt"],
    ["openai-responses", "exec", "fixture.txt"],
  ] as const)("keeps secrets off %s after %s returns %s", async (api, toolName, filename) => {
    const cwd = tempDirs.make("openclaw-tool-result-redaction-");
    const fakeSecret = "fixture-registered-secret-0123456789";
    const vendorSecret = `sk-${"fixture".repeat(6)}`;
    const benignMarker = "VISIBLE_FILE_CONTENT";
    const sourceAssignment = "token = timeObserverToken";
    registerSecretValueForRedaction(fakeSecret);
    await fs.writeFile(
      path.join(cwd, filename),
      `${benignMarker}\nVALUE=${fakeSecret}\n${vendorSecret}\n${sourceAssignment}\n`,
    );
    const readTool = createOpenClawReadTool(createReadTool(cwd), { cwd });
    const readControl = await readTool.execute("direct-read-control", { path: filename });
    const readControlText = readControl.content
      .flatMap((block) => (block.type === "text" ? [block.text] : []))
      .join("\n");
    expect(readControlText.includes(benignMarker)).toBe(true);
    await fs.writeFile(
      path.join(cwd, "fixture.cjs"),
      'process.stdout.write(require("node:fs").readFileSync("fixture.txt"));',
    );
    const quote = (value: string) =>
      `'${value.replaceAll("'", process.platform === "win32" ? "''" : "'\\''")}'`;
    const command = `${process.platform === "win32" ? "& " : ""}${quote(process.execPath)} fixture.cjs`;
    const tool =
      toolName === "read"
        ? readTool
        : createExecTool({
            cwd,
            host: "gateway",
            security: "full",
            ask: "off",
            allowBackground: false,
            notifyOnExit: false,
          });

    const model: Model = {
      ...testModel,
      api,
      provider: api === "anthropic-messages" ? "anthropic" : "openai",
      id: api === "anthropic-messages" ? "claude-sonnet-4-6" : "gpt-4.1",
      baseUrl: "https://router.invalid",
    };
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
    });
    const sessionManager = guardSessionManager(SessionManager.inMemory(cwd), {
      config: {},
      allowedToolNames: [toolName],
    });
    const resourceLoader = createEmbeddedAgentResourceLoader({
      cwd,
      agentDir: cwd,
      settingsManager,
      extensionFactories: buildEmbeddedExtensionFactories({
        cfg: {},
        sessionManager,
        provider: model.provider,
        modelId: model.id,
        model,
      }),
    });
    await resourceLoader.reload();
    let providerPayload: unknown;
    let liveContext: Context | undefined;
    streamMocks.streamSimple
      .mockImplementationOnce((activeModel: Model) =>
        createAssistantResultStream(
          createAssistant(
            activeModel,
            [
              {
                type: "toolCall",
                id: "probe-read",
                name: toolName,
                arguments: toolName === "read" ? { path: filename } : { command, workdir: cwd },
              },
            ],
            "toolUse",
          ),
        ),
      )
      .mockImplementation((_activeModel, context, options) => {
        liveContext = context;
        const capture = async (payload: unknown, requestModel: Model) => {
          const replacement = await options?.onPayload?.(payload, requestModel);
          providerPayload = replacement === undefined ? payload : replacement;
          throw new Error("synthetic probe stops before any network operation");
        };
        return api === "anthropic-messages"
          ? streamAnthropic(model as Model<"anthropic-messages">, context, {
              ...options,
              apiKey: "synthetic-probe-auth",
              onPayload: capture,
            })
          : streamOpenAIResponses(model as Model<"openai-responses">, context, {
              ...options,
              apiKey: "synthetic-probe-auth",
              onPayload: capture,
            });
      });
    const authStorage = AuthStorage.inMemory();
    authStorage.setRuntimeApiKey(model.provider, "synthetic-probe-auth");
    const modelRegistry = ModelRegistry.inMemory(authStorage);
    modelRegistry.registerProvider(model.provider, {
      api: model.api,
      streamSimple: streamMocks.streamSimple,
    });
    const { session } = await createAgentSession({
      cwd,
      agentDir: cwd,
      model,
      modelRegistry,
      authStorage,
      tools: [toolName],
      sessionManager,
      settingsManager,
      resourceLoader,
      customTools: toToolDefinitions([tool]),
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
      expect(session.getActiveToolNames().join(",")).toBe(toolName);
      await session.prompt(`Read ${filename}.`);
      expect(providerPayload !== undefined).toBe(true);
      const stored = JSON.stringify(sessionManager.getEntries());
      const liveToolResult = liveContext?.messages.findLast(
        (message) => message.role === "toolResult",
      );
      const liveToolText =
        liveToolResult?.content
          .flatMap((block) => (block.type === "text" ? [block.text] : []))
          .join("\n") ?? "";
      expect(readControlText.includes(fakeSecret)).toBe(filename !== ".env");
      expect(liveToolResult !== undefined).toBe(true);
      expect(liveToolResult?.isError).toBe(false);
      expect(liveToolText.includes(benignMarker)).toBe(true);
      expect(JSON.stringify(providerPayload).includes(benignMarker)).toBe(true);
      for (const secret of [fakeSecret, vendorSecret]) {
        expect(stored.includes(secret)).toBe(false);
        expect(liveToolText.includes(secret)).toBe(false);
        expect(JSON.stringify(providerPayload).includes(secret)).toBe(false);
      }
      if (filename !== ".env") {
        expect(liveToolText.includes(sourceAssignment)).toBe(true);
      }
      const previousToolText = liveToolText;
      await session.prompt("Continue using the previous read result.");
      const replayedToolResult = liveContext?.messages.findLast(
        (message) => message.role === "toolResult",
      );
      const replayedToolText = replayedToolResult?.content
        .flatMap((block) => (block.type === "text" ? [block.text] : []))
        .join("\n");
      expect(replayedToolText === previousToolText).toBe(true);
    } finally {
      removeGuard();
      session.dispose();
    }
  });
});
