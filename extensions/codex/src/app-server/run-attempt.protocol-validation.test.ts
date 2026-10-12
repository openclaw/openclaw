import { symlink } from "node:fs/promises";
import path from "node:path";
import { initializeGlobalHookRunner } from "openclaw/plugin-sdk/hook-runtime";
import {
  createMockPluginRegistry,
  loadUserTurnTranscriptRecorderFactoryForTest,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { readVisibleSessionTranscriptMessageEntries } from "openclaw/plugin-sdk/session-transcript-runtime";
import { describe, expect, it, vi } from "vitest";
import type { CodexSessionCatalogControl } from "../session-catalog-types.js";
import { CODEX_TURN_START_TEXT_INPUT_MAX_CHARS } from "./context-engine-projection.js";
import { assertCodexTurnStartResponse } from "./protocol-validators.js";
import type { CodexTurnStartParams, JsonObject } from "./protocol.js";
import { itemNotification, turnCompleted } from "./protocol.test-helpers.js";
import {
  assistantMessage,
  bindProductionHarnessHostCapabilitiesForTest,
  createParams,
  createTestParams,
  createStartedThreadHarness,
  runCodexAppServerAttempt,
  setupRunAttemptTestHooks,
  setCodexTestModelSupportsTools,
  tempDir,
  threadStartResult,
} from "./run-attempt-test-harness.js";
import { createContextEngine } from "./run-attempt.context-engine.test-support.js";
import {
  readCodexAppServerBinding,
  writeCodexAppServerBinding,
} from "./session-binding.test-helpers.js";
import { createCodexTestModel } from "./test-support.js";
import { resolveCodexUpstreamForkBoundary } from "./upstream-fork-boundary.js";
import { readUpstreamUserText } from "./upstream-prompt-provenance.js";

setupRunAttemptTestHooks();

describe("Codex submitted prompt provenance", () => {
  it("forks a sender-attributed turn using the exact submitted text without changing its display", async () => {
    const harness = createStartedThreadHarness();
    const params = createTestParams();
    params.agentId = "main";
    params.prompt = "  Keep the original whitespace.\n";
    params.trigger = "user";
    const target = {
      agentId: params.agentId,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey!,
      storePath: path.join(tempDir, "agent.sqlite"),
    };
    params.sessionTarget = target;
    await upsertSessionEntry({
      ...target,
      entry: { sessionId: params.sessionId, updatedAt: Date.now() },
    });
    const createRecorder = await loadUserTurnTranscriptRecorderFactoryForTest();
    const recorder = createRecorder({
      input: {
        text: params.prompt,
        idempotencyKey: `${params.runId}:user`,
        sender: { id: "profile-fork-test", name: "Fork test" },
      },
      target: { ...target, sessionEntry: undefined },
    });
    await recorder.persistApproved();
    params.userTurnTranscriptRecorder = recorder;
    // The admission owner canonicalizes its locator; the harness may retain an alias.
    const alias = path.join(tempDir, "database-alias");
    await symlink(tempDir, alias, process.platform === "win32" ? "junction" : "dir");
    params.sessionTarget = { ...target, storePath: path.join(alias, "agent.sqlite") };
    const closeHost = await bindProductionHarnessHostCapabilitiesForTest(params);
    const run = runCodexAppServerAttempt(params);
    try {
      await harness.waitForMethod("turn/start");
      const request = harness.requests.find(({ method }) => method === "turn/start")!
        .params as CodexTurnStartParams;
      const sentInput = structuredClone(request.input);
      const sentText = sentInput
        .flatMap((item) => (item.type === "text" ? [item.text] : []))
        .join("\n");
      expect(sentText).toContain('[OpenClaw conversation info: sender={"id":"profile-fork-test"');
      expect(sentText).toContain(params.prompt);
      await vi.waitFor(() => {
        expect(recorder.getPersistedMessage?.()?.["__openclaw"]?.mirrorIdentity).toBe(
          "turn-1:prompt",
        );
      });
      const earlyPrompt = recorder.getPersistedMessage?.();
      expect.soft(readUpstreamUserText(earlyPrompt)).toBe(sentText);
      expect(earlyPrompt?.content).toBe(params.prompt);
      await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
      const result = await run;
      expect
        .soft(
          readUpstreamUserText(result.messagesSnapshot.find((message) => message.role === "user")),
        )
        .toBe(sentText);
      const entries = await readVisibleSessionTranscriptMessageEntries(target);
      const entry = entries.find((candidate) => candidate.role === "user")!;
      expect(entry.message).toMatchObject({ role: "user", content: params.prompt });
      expect.soft(readUpstreamUserText(entry.message)).toBe(sentText);

      const nativeTurn = assertCodexTurnStartResponse({
        turn: {
          id: "turn-1",
          status: "completed",
          items: [{ type: "userMessage", id: "user-1", content: sentInput }],
        },
      }).turn;
      const control: CodexSessionCatalogControl = {
        withPinnedConnection: async (callback) => callback(control),
        initialize: async () => {},
        listPage: async () => ({ sessions: [] }),
        requireEligibleThread: async () => ({ id: "thread-1", projectId: null }),
        listDescendantPage: async () => ({ data: [] }),
        listTurnPage: async () => ({ data: [nativeTurn] }),
        listItemPage: async () => ({ data: [] }),
        forkThread: async () => {
          throw new Error("boundary resolution must not fork");
        },
        readThread: async () => ({ id: "thread-1", projectId: null }),
        archiveThread: async () => {
          throw new Error("boundary resolution must not archive");
        },
      };
      const boundary = await resolveCodexUpstreamForkBoundary({
        ...target,
        entryId: entry.entryId,
        threadId: "thread-1",
        canonicalThreadId: "thread-1",
        control,
      });
      expect(boundary).toMatchObject({
        ok: true,
        boundary: { beforeTurnId: "turn-1", lastRetainedTurnId: null },
        editorText: params.prompt,
      });
    } finally {
      await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
      await run;
      closeHost();
    }
  });
});

describe("native current input attachments", () => {
  it("delivers prepared document paths alongside native images without changing the canonical prompt", async () => {
    const harness = createStartedThreadHarness();
    const params = createTestParams();
    const prompt = params.prompt;
    const note = "Attachment file: /fixture/managed/inventory.csv";
    const prepare = vi.fn(async () => note);
    params.hostCapabilities = { ...params.hostCapabilities, prepareInputAttachments: prepare };
    params.model = createCodexTestModel("codex", ["text", "image"]);
    setCodexTestModelSupportsTools(params, false);
    params.images = [
      {
        type: "image",
        mimeType: "image/png",
        data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
      },
    ];
    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    const result = await run;
    const user = result.messagesSnapshot.find((message) => message.role === "user");
    expect(user).toBeDefined();
    expect(JSON.stringify(user?.content)).toContain(prompt);
    expect(JSON.stringify(user?.content)).not.toContain(note);
    const start = harness.requests.find((entry) => entry.method === "turn/start");
    const input = (start?.params as { input?: Array<{ type: string; text?: string }> })?.input;
    expect(input?.[0]?.text).toContain(note);
    expect(input?.[1]?.type).toBe("image");
    expect(params.prompt).toBe(prompt);
    expect(prepare).toHaveBeenCalledOnce();
  });

  it.each([
    { context: "inbound", projected: false },
    { context: "combined-overflow", projected: true },
  ])(
    "preserves $context with projected history $projected when adding optional paths",
    async ({ context, projected }) => {
      const harness = createStartedThreadHarness();
      const params = createTestParams();
      const combined = context.startsWith("combined");
      const expandedContext =
        "current context " +
        "i".repeat(CODEX_TURN_START_TEXT_INPUT_MAX_CHARS - (combined ? 7000 : 2048));
      const hookPrefix = "current prefix " + "p".repeat(1000);
      if (context === "inbound") {
        params.currentInboundContext = { text: expandedContext };
      } else {
        initializeGlobalHookRunner(
          createMockPluginRegistry([
            {
              hookName: "before_prompt_build",
              handler: async () => ({ prependContext: hookPrefix, appendContext: expandedContext }),
            },
          ]),
        );
      }
      if (projected) {
        params.contextEngine = createContextEngine({
          assemble: async () => ({
            messages: [
              assistantMessage(
                `${"h".repeat(context === "combined-overflow" ? 10000 : 4000)} historical tail`,
                1,
              ),
            ],
            estimatedTokens: 1000,
          }),
        });
      }
      const note = `Attachment paths: ${JSON.stringify(
        Array.from({ length: 80 }, (_, index) => ({
          path: `/fixture/managed/attachment-${index}.csv`,
        })),
      )}`;
      params.hostCapabilities = {
        ...params.hostCapabilities,
        prepareInputAttachments: async () => note,
      };
      setCodexTestModelSupportsTools(params, false);

      const run = runCodexAppServerAttempt(params);
      await harness.waitForMethod("turn/start");
      await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
      await run;
      const start = harness.requests.find((entry) => entry.method === "turn/start");
      const input = (start?.params as { input?: Array<{ type: string; text?: string }> })?.input;
      const inputText = input?.[0]?.text;
      expect(inputText?.includes(expandedContext)).toBe(true);
      expect(inputText).toContain(params.prompt);
      if (combined) {
        expect(inputText?.includes(hookPrefix)).toBe(true);
      }
      if (projected) {
        expect(inputText).toContain("historical tail");
      }
      if (combined) {
        expect(inputText).toContain(note);
      } else {
        expect(inputText).not.toContain(note);
      }
      expect(inputText?.length).toBeLessThanOrEqual(CODEX_TURN_START_TEXT_INPUT_MAX_CHARS);
    },
  );
});

describe("Codex app-server notification bursts", () => {
  it("drains bound command output without one macrotask per notification", async () => {
    const harness = createStartedThreadHarness();
    const params = createTestParams();
    const command = {
      id: "cmd-burst",
      type: "commandExecution",
      command: "generate realistic output burst",
      cwd: params.workspaceDir,
      processId: null,
      source: "agent",
      status: "completed",
      commandActions: [],
      aggregatedOutput: null,
      exitCode: 0,
      durationMs: 20,
    };
    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");
    await harness.notify(
      itemNotification("item/started", {
        ...command,
        status: "inProgress",
        exitCode: null,
        durationMs: null,
      }),
    );

    const notificationCount = 128;
    const handledOrder: number[] = [];
    const notifications = Array.from({ length: notificationCount }, (_, index) =>
      harness
        .notify({
          method: "item/commandExecution/outputDelta",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "cmd-burst",
            delta: `${index.toString().padStart(3, "0")}:${"x".repeat(8_188)}`,
          },
        })
        .then(() => {
          handledOrder.push(index);
        }),
    );

    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(handledOrder).toHaveLength(notificationCount);
    await Promise.all(notifications);
    expect(handledOrder).toEqual(Array.from({ length: notificationCount }, (_, index) => index));

    await harness.notify(
      itemNotification("item/completed", {
        ...command,
        processId: 42,
        durationMs: 20,
      }),
    );
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    const result = await run;
    expect(JSON.stringify(result.messagesSnapshot)).toContain('"toolCallId":"cmd-burst"');
  });
});

describe("Codex native resume validation", () => {
  it("rejects a resumed provider mismatch before inference and preserves the binding", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-existing",
      cwd: workspaceDir,
      model: "gpt-5.4",
      modelProvider: "openai",
      historyCoveredThrough: new Date().toISOString(),
      webSearchThreadConfigFingerprint: JSON.stringify({
        "features.standalone_web_search": false,
        web_search: "disabled",
      }),
    });
    const harness = createStartedThreadHarness(
      async (method) => {
        if (method === "thread/resume") {
          return {
            ...threadStartResult("thread-existing", { cwd: workspaceDir }),
            model: "gpt-5.4",
            modelProvider: "local-provider",
          };
        }
        if (method === "turn/start") {
          return { turn: { id: "turn-1", status: "completed", items: [] } };
        }
        return undefined;
      },
      { persistedThreads: ["thread-existing"] },
    );
    const params = createParams(sessionFile, workspaceDir);
    params.provider = "openai";
    params.modelId = "gpt-5.5";
    await expect(runCodexAppServerAttempt(params)).rejects.toHaveProperty(
      "cause.message",
      expect.stringContaining("Codex resumed a different model provider"),
    );
    expect(harness.requests.some(({ method }) => method === "thread/resume")).toBe(true);
    expect(harness.requests.some(({ method }) => method === "turn/start")).toBe(false);
    expect(await readCodexAppServerBinding(sessionFile)).toMatchObject({
      threadId: "thread-existing",
      model: "gpt-5.4",
      modelProvider: "openai",
    });
  });
});

describe("Codex native completion validation", () => {
  it.each<{ label: string; turn: JsonObject }>([
    { label: "nonterminal status", turn: { status: "inProgress", items: [] } },
    {
      label: "missing dynamic tool status",
      turn: { items: [{ id: "tool-1", type: "dynamicToolCall", tool: "render", arguments: {} }] },
    },
  ])("keeps the run open after a completion with $label", async ({ turn }) => {
    const harness = createStartedThreadHarness();
    const run = runCodexAppServerAttempt(createTestParams());
    await harness.waitForMethod("turn/start");

    await harness.notify({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", ...turn } },
    });
    await harness.notify(
      turnCompleted({
        id: "turn-1",
        status: "completed",
        items: [
          {
            id: "answer-1",
            type: "agentMessage",
            phase: "final_answer",
            text: "The native turn finished.",
          },
        ],
      }),
    );

    const result = await run;
    expect(result.terminal).toEqual({ kind: "ok" });
    expect(result.assistantTexts).toEqual(["The native turn finished."]);
  });
});
