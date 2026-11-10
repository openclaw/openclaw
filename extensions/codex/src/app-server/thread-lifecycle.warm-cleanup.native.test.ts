import fs from "node:fs/promises";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  claimCodexAppServerLiveThread,
  isCodexAppServerLiveThreadClaimed,
  isCodexAppServerLiveThreadProtected,
} from "./client-runtime.js";
import { createCodexNativeTestState } from "./native-app-server.test-support.js";
import {
  CodexNativeProcessAuthority,
  readCodexRetainedBackgroundCommands,
} from "./native-process-authority.js";
import { isJsonObject, type JsonObject } from "./protocol.js";
import * as sessionBinding from "./session-binding.js";
import { createCodexSqliteTestBindingStateStore } from "./session-binding.sqlite.test-helpers.js";
import { createIsolatedCodexAppServerClient } from "./shared-client.js";
import { startOrResumeThread } from "./thread-lifecycle-run.js";
import {
  createParams,
  resetThreadLifecycleTestFixtures,
} from "./thread-lifecycle.test-fixtures.js";
import {
  failNextWarmPublication,
  retainWarmThread,
  warmPluginConfig,
} from "./thread-lifecycle.warm-cleanup.test-support.js";
import {
  listenForNativeResponses,
  nativeAppServerOptions,
  nativeProviderConfig,
  sendNativeResponse,
} from "./thread-native.test-support.js";
import { CODEX_APP_SERVER_VERSION } from "./version.js";

vi.unmock("node:child_process");
afterEach(() => {
  resetThreadLifecycleTestFixtures();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

// The loopback provider chooses deterministic actions; the pinned native binary
// owns threads, subscriptions, shell execution, inventory, and notifications.
describe.skipIf(process.platform === "win32")("native Codex warm cleanup", () => {
  it.for([
    "publication failure",
    "protected rotation",
    "protected publication failure",
    "context refresh",
  ] as const)(
    "%s permits continuation without disturbing sibling ownership",
    { timeout: 90_000 },
    async (scenario, context) => {
      const backgroundWork = scenario !== "publication failure";
      const contextRefresh = scenario === "context refresh";
      const publicationFailure = scenario !== "protected rotation" && !contextRefresh;
      const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
        context.onTestFinished(async () => {
          await closeOpenClawStateDatabaseAsync();
          cleanup();
        }),
      );
      const root = await fs.realpath(tempDirs.make("codex-warm-proof-"));
      const native = await createCodexNativeTestState(root);
      vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
      vi.stubEnv("HOME", native.env.HOME);
      vi.stubEnv("CODEX_HOME", native.codexHome);
      let backgroundRequested = false;
      let providerRequests = 0;
      const providerFailures: unknown[] = [];
      const port = await listenForNativeResponses(context, (request, response) => {
        let body = "";
        request.setEncoding("utf8");
        request.on("data", (chunk: string) => {
          body += chunk;
        });
        request.on("end", () => {
          try {
            if (request.method !== "POST" || request.url !== "/v1/responses") {
              response.writeHead(404).end();
              return;
            }
            expect(request.headers.authorization).toBeUndefined();
            const parsed: unknown = JSON.parse(body);
            expect(isJsonObject(parsed)).toBe(true);
            providerRequests += 1;
            const launch = backgroundWork && !backgroundRequested;
            backgroundRequested ||= launch;
            const item = launch
              ? {
                  type: "function_call",
                  call_id: "native-background-command",
                  name: "exec_command",
                  arguments: JSON.stringify({
                    cmd: "echo BACKGROUND_READY; while [ ! -f finish-background ]; do /bin/sleep 0.1; done; echo BACKGROUND_DONE",
                    shell: "/bin/bash",
                    login: false,
                    yield_time_ms: 1000,
                    max_output_tokens: 200,
                  }),
                }
              : {
                  type: "message",
                  role: "assistant",
                  id: `native-answer-${providerRequests}`,
                  content: [{ type: "output_text", text: "NATIVE_CONTINUATION_OK" }],
                };
            sendNativeResponse(response, `native-response-${providerRequests}`, item);
          } catch (error) {
            providerFailures.push(error);
            response.writeHead(500).end();
          }
        });
      });
      await fs.writeFile(
        path.join(native.codexHome, "config.toml"),
        nativeProviderConfig(
          "warm-proof",
          port,
          ['sandbox_mode="danger-full-access"', "allow_login_shell=false"],
          ["code_mode=false", "shell_snapshot=false"],
        ),
      );
      const appServer = {
        ...nativeAppServerOptions(native),
        sandbox: "danger-full-access" as const,
      };
      const agentDir = path.join(root, "agent");
      const client = await createIsolatedCodexAppServerClient({
        startOptions: appServer.start,
        agentDir,
        authProfileId: null,
        config: {},
        timeoutMs: 20_000,
      });
      context.onTestFinished(async () => {
        const outcome = await client.closeAndWait();
        expect(outcome.exited).toBe(true);
      });
      expect(client.getRuntimeIdentity()?.serverVersion).toBe(CODEX_APP_SERVER_VERSION);
      const requests: { method: string; threadId?: string }[] = [];
      const originalRequest = client.request.bind(client);
      vi.spyOn(client, "request").mockImplementation((method, params, options) => {
        const threadId =
          isJsonObject(params) && typeof params.threadId === "string" ? params.threadId : undefined;
        requests.push({ method, threadId });
        return originalRequest(method, params, options);
      });
      const params = {
        ...createParams(path.join(root, "session.jsonl"), native.cwd),
        agentId: "main",
        agentDir,
        modelId: "gpt-5.6-luna",
        disableTools: false,
        ...(contextRefresh
          ? {
              contextEngine: {
                info: { id: "test", name: "Test", ownsCompaction: true },
                assemble: vi.fn(),
                compact: vi.fn(),
              } as never,
            }
          : {}),
      };
      const bindingStore = sessionBinding.createCodexAppServerBindingStore(
        createCodexSqliteTestBindingStateStore({
          namespace: "native-warm-proof",
          maxEntries: 32,
          env: { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") },
        }),
      );
      let pluginFingerprint = "original-policy";
      const common = {
        client,
        bindingStore,
        params,
        cwd: native.cwd,
        dynamicTools: [],
        contextEngineProjection: contextRefresh
          ? { mode: "thread_bootstrap" as const, epoch: "before", fingerprint: "before" }
          : undefined,
        appServer,
        userMcpServersEnabled: false,
        signal: AbortSignal.timeout(75_000),
        pluginThreadConfig: warmPluginConfig(() => pluginFingerprint),
      };
      const authority = new CodexNativeProcessAuthority(
        params.hostCapabilities,
        (error) => {
          throw error;
        },
        false,
      );
      context.onTestFinished(() => authority.release());
      const commands = new Map<string, string | null>();
      const commandFinished = createDeferred<JsonObject>();
      const completions = new Map<string, ReturnType<typeof createDeferred<JsonObject>>>();
      client.addNotificationHandler((notification) => {
        if (!isJsonObject(notification.params)) {
          return;
        }
        const event = notification.params;
        if (
          notification.method === "turn/completed" &&
          isJsonObject(event.turn) &&
          typeof event.threadId === "string"
        ) {
          completions.get(event.threadId)?.resolve(event.turn);
        }
        if (
          (notification.method === "item/started" || notification.method === "item/completed") &&
          isJsonObject(event.item) &&
          event.item.type === "commandExecution"
        ) {
          const item = event.item;
          if (notification.method === "item/started" && typeof item.id === "string") {
            commands.set(item.id, typeof item.processId === "string" ? item.processId : null);
          } else if (notification.method === "item/completed") {
            commandFinished.resolve(item);
          }
        }
      });
      const runTurn = async (threadId: string, bindBackgroundSource = false) => {
        const done = createDeferred<JsonObject>();
        completions.set(threadId, done);
        const started = await client.request("turn/start", {
          threadId,
          input: [{ type: "text", text: "Run the native continuation proof.", text_elements: [] }],
        });
        if (bindBackgroundSource) {
          authority.bindTurn(client, threadId, started.turn.id);
        }
        const completed = await done.promise;
        expect(completed.status).toBe("completed");
        return started.turn.id;
      };
      const first = await startOrResumeThread(common);
      const firstTurnId = await runTurn(first.threadId, backgroundWork);
      if (backgroundWork) {
        expect(commands.size).toBe(1);
        const consume = await readCodexRetainedBackgroundCommands({
          client,
          threadId: first.threadId,
          turnId: firstTurnId,
          commands,
          authority,
          assertCurrent: () => authority.assertCurrent(),
          signal: common.signal,
          timeoutMs: 10_000,
        });
        expect(consume().size).toBe(1);
        authority.release();
        expect(isCodexAppServerLiveThreadProtected(client, first.threadId)).toBe(true);
      }
      expect(await retainWarmThread(client, first)).toBe(true);
      const siblingParams = {
        ...params,
        sessionId: "sibling",
        sessionKey: "agent:main:sibling",
        sessionFile: path.join(root, "sibling.jsonl"),
      };
      const siblingBinding = await startOrResumeThread({ ...common, params: siblingParams });
      expect(await retainWarmThread(client, siblingBinding)).toBe(true);
      const sibling = await claimCodexAppServerLiveThread(client, siblingBinding.threadId);
      expect(sibling).toBeDefined();
      context.onTestFinished(() => sibling?.release(siblingBinding.threadId));
      const before = requests.length;
      const readBinding = () => bindingStore.read(sessionBinding.sessionBindingIdentity(params));
      const saved = readBinding();
      const expectNoRequests = (methods: string[], thread?: string, offset = before) => {
        expect(
          requests
            .slice(offset)
            .filter(
              ({ method, threadId }) =>
                methods.includes(method) && (thread === undefined || thread === threadId),
            ),
        ).toEqual([]);
      };
      let publicationClaimed = false;
      if (contextRefresh) {
        common.contextEngineProjection = {
          mode: "thread_bootstrap",
          epoch: "after",
          fingerprint: "after",
        };
      }
      if (publicationFailure) {
        const readerFailure = new Error("injected warm publication reader settlement failure");
        const fault = failNextWarmPublication(readerFailure);
        try {
          await expect(startOrResumeThread(common)).rejects.toBe(readerFailure);
        } finally {
          fault.mockRestore();
        }
        publicationClaimed = isCodexAppServerLiveThreadClaimed(client, first.threadId);
      } else {
        pluginFingerprint = "changed-policy";
        await expect(startOrResumeThread(common)).rejects.toThrow(
          `Codex thread ${first.threadId} is claimed by active work; stop it first.`,
        );
        expect(readBinding()).toEqual(saved);
        pluginFingerprint = "original-policy";
      }
      sibling!.assertCurrent();
      if (contextRefresh) {
        const beforePolicyChange = requests.length;
        await expect(
          startOrResumeThread({
            ...common,
            developerInstructions: "Changed persistent thread policy",
          }),
        ).rejects.toThrow("claimed by active work; stop it first");
        expect(readBinding()).toEqual(saved);
        expectNoRequests(
          ["thread/start", "thread/unsubscribe", "turn/start"],
          undefined,
          beforePolicyChange,
        );
      }
      const resumed = await startOrResumeThread(common);
      if (contextRefresh) {
        expect(resumed.threadId).not.toBe(first.threadId);
        expect(resumed.contextEngine?.projection?.epoch).toBe("after");
        expect(readBinding()?.threadId).toBe(resumed.threadId);
      } else {
        expect(resumed.threadId).toBe(first.threadId);
        expect(resumed.lifecycle.action).toBe("resumed");
      }
      await runTurn(resumed.threadId);
      expect(publicationClaimed).toBe(false);
      const history = await client.request("thread/read", {
        threadId: resumed.threadId,
        includeTurns: true,
      });
      expect(JSON.stringify(history.thread.turns)).toContain("NATIVE_CONTINUATION_OK");
      const transitionRequests = requests.slice(before);
      if (backgroundWork && !contextRefresh) {
        expectNoRequests(["thread/start", "thread/resume", "thread/unsubscribe"]);
      } else if (!contextRefresh) {
        for (const method of ["thread/unsubscribe", "thread/resume"]) {
          expect(transitionRequests).toContainEqual({ method, threadId: first.threadId });
        }
      }
      if (contextRefresh) {
        expectNoRequests(["thread/unsubscribe"], first.threadId);
      }
      expectNoRequests(["thread/unsubscribe"], siblingBinding.threadId);
      sibling!.assertCurrent();
      await runTurn(siblingBinding.threadId);
      sibling!.assertCurrent();
      if (backgroundWork) {
        const inventory = await client.request("thread/backgroundTerminals/list", {
          threadId: first.threadId,
        });
        expect(inventory.data).toHaveLength(1);
        const background = inventory.data[0];
        if (!background) {
          throw new Error("Native background command disappeared");
        }
        expect(commands.has(background.itemId)).toBe(true);
        expect(isCodexAppServerLiveThreadProtected(client, first.threadId)).toBe(true);
        await fs.writeFile(path.join(native.cwd, "finish-background"), "finish\n");
        await expect(commandFinished.promise).resolves.toMatchObject({
          status: "completed",
          exitCode: 0,
          aggregatedOutput: expect.stringContaining("BACKGROUND_DONE"),
        });
        expect(isCodexAppServerLiveThreadProtected(client, first.threadId)).toBe(false);
        expect(authority.commands.size).toBe(0);
      }
      expect(client.getCloseError()).toBeUndefined();
      expect(providerFailures).toEqual([]);
      await resumed.liveThreadOwnership?.release(resumed.threadId);
    },
  );
});
