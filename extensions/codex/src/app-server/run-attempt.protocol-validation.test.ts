import { symlink } from "node:fs/promises";
import path from "node:path";
import { initializeGlobalHookRunner } from "openclaw/plugin-sdk/hook-runtime";
import {
  createMockPluginRegistry,
  loadUserTurnTranscriptRecorderFactoryForTest,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { setRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { readVisibleSessionTranscriptMessageEntries } from "openclaw/plugin-sdk/session-transcript-runtime";
import { expect, it, vi } from "vitest";
import type { CodexSessionCatalogControl } from "../session-catalog-types.js";
import { nativeCommandItem } from "./codex-app-server.test-fixtures.js";
import { CODEX_TURN_START_TEXT_INPUT_MAX_CHARS } from "./context-engine-projection.js";
import { assertCodexTurnStartResponse } from "./protocol-validators.js";
import type { CodexTurnStartParams, JsonObject } from "./protocol.js";
import { itemNotification, turnCompleted } from "./protocol.test-helpers.js";
import {
  assistantMessage,
  bindProductionHarnessHostCapabilitiesForTest,
  createTestParams,
  createStartedThreadHarness,
  runCodexAppServerAttempt,
  setupRunAttemptTestHooks,
  setCodexTestModelSupportsTools,
  tempDir,
} from "./run-attempt-test-harness.js";
import { createContextEngine } from "./run-attempt.context-engine.test-support.js";
import { createCodexTestModel } from "./test-support.js";
import { resolveCodexUpstreamForkBoundary } from "./upstream-fork-boundary.js";
import { readUpstreamUserText } from "./upstream-prompt-provenance.js";

setupRunAttemptTestHooks();

function turnInput(harness: ReturnType<typeof createStartedThreadHarness>) {
  return (
    harness.requests.find(({ method }) => method === "turn/start")!.params as CodexTurnStartParams
  ).input;
}

async function completedInput(params: ReturnType<typeof createTestParams>) {
  setCodexTestModelSupportsTools(params, false);
  const harness = createStartedThreadHarness();
  const run = runCodexAppServerAttempt(params);
  await harness.waitForMethod("turn/start");
  await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
  return { result: await run, input: turnInput(harness) };
}

it("forks a sender-attributed turn through a database alias using exact submitted text without changing its display", async () => {
  const harness = createStartedThreadHarness();
  const params = createTestParams();
  const abortController = new AbortController();
  params.abortSignal = abortController.signal;
  setRuntimeConfigSnapshot(params.config ?? {});
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
  await bindProductionHarnessHostCapabilitiesForTest(params);
  const run = runCodexAppServerAttempt(params);
  try {
    await run.waitForTurnAccepted();
    const sentInput = structuredClone(turnInput(harness));
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
    const user = result.messagesSnapshot.find((message) => message.role === "user");
    expect.soft(readUpstreamUserText(user)).toBe(sentText);
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
    const readThread = async () => ({ id: "thread-1", projectId: null });
    const forbidden = async () => {
      throw new Error("boundary resolution must not mutate");
    };
    const control: CodexSessionCatalogControl = {
      withPinnedConnection: async (callback) => callback(control),
      initialize: async () => {},
      listPage: async () => ({ sessions: [] }),
      requireEligibleThread: readThread,
      listDescendantPage: async () => ({ data: [] }),
      listTurnPage: async () => ({ data: [nativeTurn] }),
      listItemPage: async () => ({ data: [] }),
      forkThread: forbidden,
      readThread,
      archiveThread: forbidden,
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
    // The shared harness closes the host after this attempt settles, including admission failure.
    abortController.abort();
    await run.catch(() => {});
  }
});
it("delivers prepared document paths alongside native images without changing the canonical prompt", async () => {
  const params = createTestParams();
  const prompt = params.prompt;
  const note = "Attachment file: /fixture/managed/inventory.csv";
  params.hostCapabilities = {
    ...params.hostCapabilities,
    prepareInputAttachments: async () => note,
  };
  params.model = createCodexTestModel("codex", ["text", "image"]);
  params.images = [
    {
      type: "image",
      mimeType: "image/png",
      data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
    },
  ];
  const { result, input } = await completedInput(params);
  const user = result.messagesSnapshot.find((message) => message.role === "user");
  expect(JSON.stringify(user?.content)).toContain(prompt);
  expect(JSON.stringify(user?.content)).not.toContain(note);
  expect(input?.[0]).toMatchObject({ type: "text", text: expect.stringContaining(note) });
  expect(input?.[1]?.type).toBe("image");
  expect(params.prompt).toBe(prompt);
});

it.each([false, true])(
  "preserves inbound context with combined projected history %s when adding optional paths",
  async (combined) => {
    const params = createTestParams();
    const expandedContext =
      "current context " +
      "i".repeat(CODEX_TURN_START_TEXT_INPUT_MAX_CHARS - (combined ? 7000 : 2048));
    const hookPrefix = "current prefix " + "p".repeat(1000);
    if (combined) {
      initializeGlobalHookRunner(
        createMockPluginRegistry([
          {
            hookName: "before_prompt_build",
            handler: async () => ({ prependContext: hookPrefix, appendContext: expandedContext }),
          },
        ]),
      );
      params.contextEngine = createContextEngine({
        assemble: async () => ({
          messages: [assistantMessage(`${"h".repeat(10000)} historical tail`, 1)],
          estimatedTokens: 1000,
        }),
      });
    } else {
      params.currentInboundContext = { text: expandedContext };
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

    const { input } = await completedInput(params);
    const inputText = input[0]?.type === "text" ? input[0].text : undefined;
    expect(inputText).toContain(expandedContext);
    expect(inputText).toContain(params.prompt);
    if (combined) {
      expect(inputText).toContain(hookPrefix);
      expect(inputText).toContain("historical tail");
      expect(inputText).toContain(note);
    } else {
      expect(inputText).not.toContain(note);
    }
    expect(inputText?.length).toBeLessThanOrEqual(CODEX_TURN_START_TEXT_INPUT_MAX_CHARS);
  },
);
it("drains bound command output without one macrotask per notification", async () => {
  const harness = createStartedThreadHarness();
  const params = createTestParams();
  const command = {
    ...nativeCommandItem("cmd-burst", "completed", 20),
    cwd: params.workspaceDir,
    aggregatedOutput: null,
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

  await harness.notify(itemNotification("item/completed", { ...command, processId: 42 }));
  await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
  const result = await run;
  expect(JSON.stringify(result.messagesSnapshot)).toContain('"toolCallId":"cmd-burst"');
});
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
  const text = "Done.";
  await harness.notify(
    turnCompleted({
      id: "turn-1",
      status: "completed",
      items: [{ id: "answer-1", type: "agentMessage", phase: "final_answer", text }],
    }),
  );

  expect(await run).toEqual(
    expect.objectContaining({ terminal: { kind: "ok" }, assistantTexts: [text] }),
  );
});
