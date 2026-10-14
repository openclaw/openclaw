import fs from "node:fs/promises";
import path from "node:path";
import { resolveDefaultAgentDir } from "openclaw/plugin-sdk/agent-runtime";
import { KeyedAsyncQueue } from "openclaw/plugin-sdk/keyed-async-queue";
import { describe, expect, it, vi } from "vitest";
import {
  consumeCodexAppServerLiveThread,
  hasCodexAppServerLiveThread,
  isCodexAppServerLiveThreadClaimed,
  releaseCodexAppServerLiveThread,
} from "./app-server/client-runtime.js";
import { CodexAppServerClient } from "./app-server/client.js";
import { threadStartResult } from "./app-server/codex-app-server.test-fixtures.js";
import { codexNativeSubagentMonitorRuntime } from "./app-server/native-subagent-monitor.js";
import { nativeCompletionNotification } from "./app-server/native-subagent-monitor.test-support.js";
import { isJsonObject, type CodexServerNotification } from "./app-server/protocol.js";
import {
  CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
  CODEX_APP_SERVER_BINDING_NAMESPACE,
} from "./app-server/session-binding-store.js";
import { createCodexAppServerBindingStore } from "./app-server/session-binding.js";
import { createCodexSqliteTestBindingStateStore } from "./app-server/session-binding.sqlite.test-helpers.js";
import {
  getLeasedSharedCodexAppServerClient,
  releaseLeasedSharedCodexAppServerClient,
} from "./app-server/shared-client.js";
import { createClientHarness } from "./app-server/test-support.js";
import { createCodexCommand } from "./commands.js";
import {
  createContext,
  createCodexRuntimeContextOverrides,
  useCodexCommandTestState,
} from "./commands.test-support.js";

let tempDir: string;

describe("codex command", () => {
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
      const parentThreadId = "r5-native-parent";
      const parentTurnId = "r5-original-parent-turn";
      const identity = {
        kind: "session" as const,
        agentId: "main",
        sessionId: "session-1",
        sessionKey: context.sessionKey,
      };
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
      };
      const startedThread = threadStartResult(threadId, "/repo");
      const response = {
        ...startedThread,
        model: "gpt-5.4",
        thread: {
          ...startedThread.thread,
          sessionId: threadId,
          source: "appServer",
          canAcceptDirectInput: true,
        },
      };
      let nativeGeneration = 1;
      let nativeLoaded = true;
      let replyToLoadedSnapshot: (() => void) | undefined;
      const unsubscribeGenerations: number[] = [];
      const harness = createClientHarness({
        onWrite(line, send) {
          const message: unknown = JSON.parse(line);
          if (
            !isJsonObject(message) ||
            typeof message.method !== "string" ||
            message.id === undefined
          ) {
            return;
          }
          let result: unknown;
          switch (message.method) {
            case "initialize":
              result = { userAgent: "codex-cli/0.154.0", codexHome: nativeHome };
              break;
            case "account/read":
              result = { account: null, requiresOpenaiAuth: false };
              break;
            case "config/read":
              result = { config: {}, origins: {}, layers: [] };
              break;
            case "thread/read":
              result = {
                thread: {
                  ...response.thread,
                  status: { type: nativeLoaded ? "idle" : "notLoaded" },
                },
              };
              break;
            case "thread/resume":
              nativeGeneration += 1;
              nativeLoaded = true;
              result = response;
              break;
            case "thread/unsubscribe":
              unsubscribeGenerations.push(nativeGeneration);
              nativeLoaded = false;
              result = { status: "unsubscribed" };
              break;
            case "thread/loaded/list": {
              const snapshot = { data: nativeLoaded ? [threadId] : [], nextCursor: null };
              replyToLoadedSnapshot = () => send({ id: message.id, result: snapshot });
              return;
            }
            default:
              send({
                id: message.id,
                error: { code: -32601, message: `Unexpected R5 wire method ${message.method}` },
              });
              return;
          }
          send({ id: message.id, result });
        },
      });
      const notifications: Array<{
        notification: CodexServerNotification;
        completion: Promise<void> | void;
      }> = [];
      const addNotificationHandler = harness.client.addNotificationHandler.bind(harness.client);
      const notificationObserver = vi
        .spyOn(harness.client, "addNotificationHandler")
        .mockImplementation((handler) =>
          addNotificationHandler((notification) => {
            const completion = handler(notification);
            notifications.push({ notification, completion });
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
      const drainTransitions = async () => {
        let joined = 0;
        while (joined < transitionObservation.mock.results.length) {
          const pending = transitionObservation.mock.results.slice(joined);
          joined = transitionObservation.mock.results.length;
          await Promise.all(
            pending.flatMap((entry) => (entry.type === "return" ? [entry.value] : [])),
          );
        }
      };
      let leasedClient: CodexAppServerClient | undefined;
      let parent:
        | Awaited<ReturnType<typeof codexNativeSubagentMonitorRuntime.register>>
        | undefined;
      let successor: Awaited<ReturnType<typeof consumeCodexAppServerLiveThread>>;
      try {
        leasedClient = await getLeasedSharedCodexAppServerClient({
          pluginConfig,
          config: context.config,
          agentDir: resolveDefaultAgentDir(context.config),
        });
        expect(leasedClient).toBe(harness.client);
        parent = await codexNativeSubagentMonitorRuntime.register({
          client: leasedClient,
          parentThreadId,
        });
        parent.bindTurn(parentTurnId);
        harness.send({
          method: "thread/started",
          params: {
            thread: {
              id: threadId,
              parentThreadId,
              source: {
                subAgent: {
                  thread_spawn: {
                    parent_thread_id: parentThreadId,
                    depth: 1,
                    agent_path: threadId,
                  },
                },
              },
            },
          },
        });
        await vi.waitFor(() =>
          expect(isCodexAppServerLiveThreadClaimed(harness.client, threadId)).toBe(true),
        );
        harness.send(
          nativeCompletionNotification({
            parentThreadId,
            turnId: parentTurnId,
            agentPath: threadId,
          }),
        );
        await vi.waitFor(() => {
          expect(isCodexAppServerLiveThreadClaimed(harness.client, threadId)).toBe(false);
          expect(hasCodexAppServerLiveThread(harness.client, threadId)).toBe(true);
        });
        const closeItem = {
          id: "r5-original-close",
          type: "collabAgentToolCall",
          tool: "closeAgent",
          senderThreadId: parentThreadId,
          receiverThreadIds: [threadId],
          agentsStates: { [threadId]: { status: "completed" } },
        };
        const closeStart: CodexServerNotification = {
          method: "item/started",
          params: {
            threadId: parentThreadId,
            turnId: parentTurnId,
            item: { ...closeItem, status: "inProgress" },
          },
        };
        const startCursor = notifications.length;
        harness.send(closeStart);
        await vi.waitFor(() =>
          expect(
            notifications.slice(startCursor).map((entry) => entry.notification),
          ).toContainEqual(closeStart),
        );
        await Promise.all(
          notifications.slice(startCursor).map((entry) => Promise.resolve(entry.completion)),
        );
        await drainTransitions();
        await expect(releaseCodexAppServerLiveThread(harness.client, threadId)).resolves.toBe(true);
        nativeLoaded = false;
        const unsubscribesBeforeClose = unsubscribeGenerations.length;
        const closeCompletion: CodexServerNotification = {
          method: "item/completed",
          params: {
            threadId: parentThreadId,
            turnId: parentTurnId,
            item: { ...closeItem, status: "completed" },
          },
        };
        const completionCursor = notifications.length;
        harness.send(closeCompletion);
        await vi.waitFor(() => expect(replyToLoadedSnapshot).toBeTypeOf("function"));
        const command = createCodexCommand({ pluginConfig, deps: { bindingStore } });
        const reply = await command.handler(
          createContext(`resume ${threadId}`, undefined, context),
        );
        expect(reply.text).toContain("Attached this OpenClaw session");
        expect(bindingStore.read(identity)).toMatchObject({
          threadId,
          clientId: harness.client.getInstanceId(),
        });
        expect(starts).toBe(1);
        expect(nativeGeneration).toBe(2);
        if (scenario === "claimed-successor") {
          successor = await consumeCodexAppServerLiveThread(harness.client, threadId);
          expect(successor).toBeDefined();
          successor?.assertCurrent();
        }
        const bindingBeforeClose = bindingStore.read(identity);
        replyToLoadedSnapshot?.();
        await vi.waitFor(() =>
          expect(
            notifications.slice(completionCursor).map((entry) => entry.notification),
          ).toContainEqual(closeCompletion),
        );
        await Promise.all(
          notifications.slice(completionCursor).map((entry) => Promise.resolve(entry.completion)),
        );
        await drainTransitions();
        const bindingAfterClose = bindingStore.read(identity);
        if (scenario !== "claimed-successor") {
          successor = await consumeCodexAppServerLiveThread(harness.client, threadId);
        }
        expect(bindingAfterClose).toEqual(bindingBeforeClose);
        expect(unsubscribeGenerations.slice(unsubscribesBeforeClose)).toEqual([]);
        expect(nativeLoaded).toBe(true);
        expect(successor).toBeDefined();
        successor?.assertCurrent();
      } finally {
        await parent?.unregister();
        await successor?.release(threadId);
        if (leasedClient) {
          expect(releaseLeasedSharedCodexAppServerClient(leasedClient)).toBe(true);
          expect(releaseLeasedSharedCodexAppServerClient(leasedClient)).toBe(false);
        }
        await harness.client.closeAndWait();
        transitionObservation.mockRestore();
        notificationObserver.mockRestore();
        start.mockRestore();
      }
    },
  );
});
