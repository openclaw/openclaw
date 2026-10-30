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
  closeAgentNotification,
  nativeCompletionNotification,
  registerCodexNativeSubagentMonitor as registerParent,
  threadRead,
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
    const context = await createCodexRuntimeContextOverrides(tempDir, `agent:main:${scenario}`);
    const nativeHome = path.join(tempDir, "native-home");
    await fs.mkdir(nativeHome);
    vi.stubEnv("CODEX_HOME", nativeHome);
    const threadId = "child-thread";
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
    let nativeLoaded = true;
    let replyToLoadedSnapshot: (() => void) | undefined;
    let unsubscribes = 0;
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
        nativeLoaded = true;
      } else if (method === "thread/unsubscribe") {
        unsubscribes += 1;
        nativeLoaded = false;
      }
      send(
        result === undefined
          ? { id, error: { code: -32601, message: `Unexpected R5 wire method ${method}` } }
          : { id, result },
      );
    });
    const notifications = new Map<string, Promise<void>[]>();
    const addNotificationHandler = harness.client.addNotificationHandler.bind(harness.client);
    vi.spyOn(harness.client, "addNotificationHandler").mockImplementation((handler) =>
      addNotificationHandler((notification) => {
        const completion = Promise.resolve(handler(notification));
        const key = JSON.stringify(notification);
        notifications.set(key, [...(notifications.get(key) ?? []), completion]);
        return completion;
      }),
    );
    vi.spyOn(CodexAppServerClient, "start")
      .mockRejectedValue(new Error("Unexpected second physical app-server client"))
      .mockResolvedValueOnce(harness.client);
    const transitionObservation = vi.spyOn(KeyedAsyncQueue.prototype, "enqueue");
    const settleNotification = async (notification: CodexServerNotification) => {
      const key = JSON.stringify(notification);
      await vi.waitFor(() => expect(notifications.has(key)).toBe(true));
      await Promise.all(notifications.get(key) ?? []);
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
      parent = await registerParent({ client: leasedClient, parentThreadId });
      parent.bindTurn(turnId);
      harness.send({
        method: "thread/started",
        params: {
          thread: {
            id: threadId,
            parentThreadId,
            source: threadRead({ agentPath: threadId }).thread.source,
          },
        },
      });
      await vi.waitFor(() => expect(isClaimed(harness.client, threadId)).toBe(true));
      harness.send(nativeCompletionNotification({ turnId, agentPath: threadId }));
      await vi.waitFor(() => {
        expect(isClaimed(harness.client, threadId)).toBe(false);
        expect(hasCodexAppServerLiveThread(harness.client, threadId)).toBe(true);
      });
      const closeStart = closeAgentNotification({ method: "item/started" });
      harness.send(closeStart);
      await settleNotification(closeStart);
      await expect(releaseCodexAppServerLiveThread(harness.client, threadId)).resolves.toBe(true);
      nativeLoaded = false;
      const unsubscribesBeforeClose = unsubscribes;
      const closeCompletion = closeAgentNotification({ method: "item/completed" });
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
      if (scenario === "claimed-successor") {
        successor = await consumeCodexAppServerLiveThread(harness.client, threadId);
        expect(successor).toBeDefined();
        successor?.assertCurrent();
      }
      const bindingBeforeClose = readBinding();
      replyToLoadedSnapshot?.();
      await settleNotification(closeCompletion);
      expect(readBinding()).toEqual(bindingBeforeClose);
      successor ??= await consumeCodexAppServerLiveThread(harness.client, threadId);
      expect(unsubscribes).toBe(unsubscribesBeforeClose);
      expect(nativeLoaded).toBe(true);
      expect(successor).toBeDefined();
      successor?.assertCurrent();
    } finally {
      await parent?.unregister();
      await successor?.release(threadId);
      if (leasedClient) {
        releaseClient(leasedClient);
      }
      await harness.client.closeAndWait();
      vi.restoreAllMocks();
    }
  },
);
