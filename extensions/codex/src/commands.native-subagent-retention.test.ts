import fs from "node:fs/promises";
import path from "node:path";
import { resolveDefaultAgentDir } from "openclaw/plugin-sdk/agent-runtime";
import { KeyedAsyncQueue } from "openclaw/plugin-sdk/keyed-async-queue";
import { expect, it, vi } from "vitest";
import {
  consumeCodexAppServerLiveThread,
  hasCodexAppServerLiveThread,
  isCodexAppServerLiveThreadClaimed as isClaimed,
  releaseCodexAppServerLiveThread,
} from "./app-server/client-runtime.js";
import { CodexAppServerClient } from "./app-server/client.js";
import type { CodexPluginConfig } from "./app-server/config.js";
import {
  collabItem,
  itemNotification,
  nativeCompletionNotification,
  registerCodexNativeSubagentMonitor as registerParent,
} from "./app-server/native-subagent-monitor.test-support.js";
import type { CodexServerNotification } from "./app-server/protocol.js";
import {
  CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
  CODEX_APP_SERVER_BINDING_NAMESPACE,
} from "./app-server/session-binding-store.js";
import { createCodexAppServerBindingStore } from "./app-server/session-binding.js";
import { createCodexSqliteTestBindingStateStore } from "./app-server/session-binding.sqlite.test-helpers.js";
import {
  getLeasedSharedCodexAppServerClient,
  releaseLeasedSharedCodexAppServerClient as releaseClient,
} from "./app-server/shared-client.js";
import { createRequestClientHarness } from "./app-server/test-support.js";
import { createCodexCommandHost } from "./command-host.test-support.js";
import { createCodexCommand } from "./commands.js";
import {
  createContext,
  createCodexRuntimeContextOverrides,
  createThreadResumeResponse,
  useCodexCommandTestState,
} from "./commands.test-support.js";

let tempDir: string;

useCodexCommandTestState({
  onSetup: (stateDir) => {
    tempDir = stateDir;
  },
});

it.each(["claimed-successor", "retained-successor"] as const)(
  "delayed native close preserves %s ownership",
  async (scenario) => {
    const context = await createCodexRuntimeContextOverrides(
      tempDir,
      `agent:main:test:r5:${scenario}`,
    );
    const nativeHome = path.join(tempDir, "native-home");
    await fs.mkdir(nativeHome);
    vi.stubEnv("CODEX_HOME", nativeHome);
    const threadId = "r5-native-child";
    const parentThreadId = "parent-thread";
    const turnId = "parent-turn";
    const bindingStore = createCodexAppServerBindingStore(
      createCodexSqliteTestBindingStateStore({
        namespace: CODEX_APP_SERVER_BINDING_NAMESPACE,
        maxEntries: CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
        overflowPolicy: "reject-new",
        env: { ...process.env, OPENCLAW_STATE_DIR: tempDir },
      }),
    );
    const pluginConfig = {
      appServer: {
        command: process.execPath,
        args: ["app-server"],
        homeScope: "user",
        requestTimeoutMs: 10_000,
      },
    } satisfies CodexPluginConfig;
    const response = createThreadResumeResponse({ threadId, canAcceptDirectInput: true });
    let nativeGeneration = 1;
    let nativeLoaded = true;
    let replyToLoadedSnapshot: (() => void) | undefined;
    const unsubscribeGenerations: number[] = [];
    const responses: Record<string, unknown> = {
      initialize: { userAgent: "codex-cli/0.154.0", codexHome: nativeHome },
      "account/read": { account: null, requiresOpenaiAuth: false },
      "config/read": { config: {}, origins: {}, layers: [] },
      "thread/resume": response,
      "thread/unsubscribe": { status: "unsubscribed" },
    };
    const harness = createRequestClientHarness((method, id, _requestParams, send) => {
      let result = Object.hasOwn(responses, method) ? responses[method] : undefined;
      if (method === "thread/loaded/list") {
        const snapshot = { data: nativeLoaded ? [threadId] : [], nextCursor: null };
        replyToLoadedSnapshot = () => send({ id, result: snapshot });
        return;
      }
      if (method === "thread/read") {
        result = {
          thread: { ...response.thread, status: { type: nativeLoaded ? "idle" : "notLoaded" } },
        };
      } else if (method === "thread/resume") {
        nativeGeneration += 1;
        nativeLoaded = true;
      } else if (method === "thread/unsubscribe") {
        unsubscribeGenerations.push(nativeGeneration);
        nativeLoaded = false;
      }
      send(
        result === undefined
          ? { id, error: { code: -32601, message: `Unexpected R5 wire method ${method}` } }
          : { id, result },
      );
    });
    const notifications: [CodexServerNotification, Promise<void> | void][] = [];
    const addNotificationHandler = harness.client.addNotificationHandler.bind(harness.client);
    const notificationObserver = vi
      .spyOn(harness.client, "addNotificationHandler")
      .mockImplementation((handler) =>
        addNotificationHandler((notification) => {
          const completion = handler(notification);
          notifications.push([notification, completion]);
          return completion;
        }),
      );
    let starts = 0;
    const start = vi.spyOn(CodexAppServerClient, "start").mockImplementation(async () => {
      if (starts++ > 0) {
        throw new Error("R5 proof unexpectedly requested a second physical app-server client");
      }
      return harness.client;
    });
    const transitionObservation = vi.spyOn(KeyedAsyncQueue.prototype, "enqueue");
    const settleNotification = async (cursor: number, notification: CodexServerNotification) => {
      await vi.waitFor(() =>
        expect(notifications.slice(cursor).map(([seen]) => seen)).toContainEqual(notification),
      );
      await Promise.all(
        notifications.slice(cursor).map(([, completion]) => Promise.resolve(completion)),
      );
      let joined = 0;
      while (joined < transitionObservation.mock.results.length) {
        const pending = transitionObservation.mock.results.slice(joined);
        joined = transitionObservation.mock.results.length;
        await Promise.all(
          pending.flatMap((entry) => (entry.type === "return" ? [entry.value] : [])),
        );
      }
    };
    const readBinding = () => bindingStore.read({ kind: "session", ...context.sessionTarget });
    let leasedClient: CodexAppServerClient | undefined;
    let parent: Awaited<ReturnType<typeof registerParent>> | undefined;
    let successor: Awaited<ReturnType<typeof consumeCodexAppServerLiveThread>>;
    try {
      leasedClient = await getLeasedSharedCodexAppServerClient({
        pluginConfig,
        config: context.config,
        agentDir: resolveDefaultAgentDir(context.config),
      });
      expect(leasedClient).toBe(harness.client);
      parent = await registerParent({ client: leasedClient, parentThreadId });
      parent.bindTurn(turnId);
      const spawn = { parent_thread_id: parentThreadId, depth: 1, agent_path: threadId };
      harness.send({
        method: "thread/started",
        params: {
          thread: {
            id: threadId,
            parentThreadId,
            source: { subAgent: { thread_spawn: spawn } },
          },
        },
      });
      await vi.waitFor(() => expect(isClaimed(harness.client, threadId)).toBe(true));
      harness.send(nativeCompletionNotification({ turnId, agentPath: threadId }));
      await vi.waitFor(() => {
        expect(isClaimed(harness.client, threadId)).toBe(false);
        expect(hasCodexAppServerLiveThread(harness.client, threadId)).toBe(true);
      });
      const closeItem = collabItem("closeAgent", [threadId], {
        id: "r5-original-close",
        agentsStates: { [threadId]: { status: "completed" } },
      });
      const startedItem = { ...closeItem, status: "inProgress" };
      const closeStart = itemNotification(startedItem, turnId, parentThreadId, "started");
      const startCursor = notifications.length;
      harness.send(closeStart);
      await settleNotification(startCursor, closeStart);
      await expect(releaseCodexAppServerLiveThread(harness.client, threadId)).resolves.toBe(true);
      nativeLoaded = false;
      const unsubscribesBeforeClose = unsubscribeGenerations.length;
      const closeCompletion = itemNotification(closeItem, turnId, parentThreadId);
      const completionCursor = notifications.length;
      harness.send(closeCompletion);
      await vi.waitFor(() => expect(replyToLoadedSnapshot).toBeTypeOf("function"));
      const command = createCodexCommand({
        pluginConfig,
        deps: createCodexCommandHost({ bindingStore }),
      });
      const reply = await command.handler(createContext(`resume ${threadId}`, undefined, context));
      expect(reply.text).toContain("Attached this OpenClaw session");
      expect(readBinding()).toMatchObject({
        threadId,
        clientId: harness.client.getInstanceId(),
      });
      expect({ starts, nativeGeneration }).toEqual({ starts: 1, nativeGeneration: 2 });
      if (scenario === "claimed-successor") {
        successor = await consumeCodexAppServerLiveThread(harness.client, threadId);
        expect(successor).toBeDefined();
        successor?.assertCurrent();
      }
      const bindingBeforeClose = readBinding();
      replyToLoadedSnapshot?.();
      await settleNotification(completionCursor, closeCompletion);
      expect(readBinding()).toEqual(bindingBeforeClose);
      successor ??= await consumeCodexAppServerLiveThread(harness.client, threadId);
      expect(unsubscribeGenerations.slice(unsubscribesBeforeClose)).toEqual([]);
      expect(nativeLoaded).toBe(true);
      expect(successor).toBeDefined();
      successor?.assertCurrent();
    } finally {
      await parent?.unregister();
      await successor?.release(threadId);
      if (leasedClient) {
        expect([releaseClient(leasedClient), releaseClient(leasedClient)]).toEqual([true, false]);
      }
      await harness.client.closeAndWait();
      transitionObservation.mockRestore();
      notificationObserver.mockRestore();
      start.mockRestore();
    }
  },
);
