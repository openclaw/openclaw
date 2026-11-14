import fs from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { racePromiseWithAbortSignal } from "openclaw/plugin-sdk/time-runtime";
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
import * as stdioTransport from "./transport-stdio.js";
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
    "context refresh with plugin rotation",
    "source cancellation",
    "source completion during inventory",
    "source completion before retry",
  ] as const)(
    "%s permits continuation without disturbing sibling ownership",
    { timeout: 90_000 },
    async (scenario, context) => {
      const backgroundWork = scenario !== "publication failure";
      const sourceIsolation = scenario.startsWith("source ");
      const rotatingAfterCleanup = scenario === "context refresh with plugin rotation";
      const contextRefresh = scenario === "context refresh" || rotatingAfterCleanup;
      const publicationFailure = scenario.includes("publication failure");
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
      let backgroundCallId = "native-background-command";
      let backgroundCommand =
        "echo BACKGROUND_READY; while [ ! -f finish-background ]; do /bin/sleep 0.1; done; echo BACKGROUND_DONE";
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
                  call_id: backgroundCallId,
                  name: "exec_command",
                  arguments: JSON.stringify({
                    cmd: backgroundCommand,
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
      const physicalTerminations: { threadId: string; processId: string }[] = [];
      const rejectedIngress = createDeferred<{
        id: number | string;
        threadId: string;
        processId: string;
      }>();
      let releaseRejectedIngress: (() => void) | undefined;
      let rejectTermination = scenario === "source completion before retry";
      if (sourceIsolation) {
        const createTransport = stdioTransport.createStdioTransport;
        vi.spyOn(stdioTransport, "createStdioTransport").mockImplementation(
          (options, env, current, onSpawn) =>
            createTransport(options, env, current, (child) => {
              const nativeOutput = child.stdout;
              const output = new PassThrough();
              nativeOutput.pipe(output);
              nativeOutput.once("error", (error) => output.destroy(error));
              child.stdout = output;
              context.onTestFinished(() => {
                nativeOutput.unpipe(output);
                output.destroy();
              });
              const write = child.stdin.write.bind(child.stdin);
              vi.spyOn(child.stdin, "write").mockImplementation(
                (
                  chunk: unknown,
                  encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
                  callback?: (error?: Error | null) => void,
                ) => {
                  const text =
                    typeof chunk === "string"
                      ? chunk
                      : chunk instanceof Uint8Array
                        ? new TextDecoder().decode(chunk)
                        : "";
                  const frame: unknown = JSON.parse(text);
                  const done =
                    typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
                  const params =
                    isJsonObject(frame) && isJsonObject(frame.params) ? frame.params : undefined;
                  const termination =
                    isJsonObject(frame) &&
                    frame.method === "thread/backgroundTerminals/terminate" &&
                    params &&
                    typeof params.threadId === "string" &&
                    typeof params.processId === "string"
                      ? { threadId: params.threadId, processId: params.processId }
                      : undefined;
                  if (
                    termination &&
                    rejectTermination &&
                    isJsonObject(frame) &&
                    (typeof frame.id === "number" || typeof frame.id === "string")
                  ) {
                    rejectTermination = false;
                    const id = frame.id;
                    releaseRejectedIngress = () => {
                      output.write(
                        JSON.stringify({
                          id,
                          error: { code: -32001, message: "Server overloaded" },
                        }) + "\n",
                      );
                      releaseRejectedIngress = undefined;
                    };
                    rejectedIngress.resolve({ id, ...termination });
                    done?.();
                    return true;
                  }
                  const written = (error?: Error | null) => {
                    if (!error && termination) {
                      physicalTerminations.push(termination);
                    }
                    done?.(error);
                  };
                  return typeof encodingOrCallback === "string"
                    ? write(chunk, encodingOrCallback, written)
                    : write(chunk, written);
                },
              );
              onSpawn?.(child);
            }),
        );
      }
      let pauseInventory = false;
      let inventorySnapshot: unknown;
      const inventoryEntered = createDeferred<void>();
      const inventoryReleased = createDeferred<void>();
      const terminationSettled = createDeferred<void>();
      let terminationFailure: unknown;
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
        const pending = originalRequest(method, params, options);
        if (method === "thread/backgroundTerminals/terminate") {
          return pending
            .catch((error: unknown) => {
              terminationFailure = error;
              throw error;
            })
            .finally(() => terminationSettled.resolve());
        }
        return pending.then((result) => {
          if (pauseInventory && method === "thread/backgroundTerminals/list") {
            pauseInventory = false;
            inventorySnapshot = result;
            inventoryEntered.resolve();
            return inventoryReleased.promise.then(() => result);
          }
          return result;
        });
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
      let pluginBuilds = 0;
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
        pluginThreadConfig: warmPluginConfig(() => {
          pluginBuilds++;
          return pluginFingerprint;
        }),
      };
      const sourceAbort = new AbortController();
      const sourceReleased = vi.fn();
      const authority = new CodexNativeProcessAuthority(
        sourceIsolation
          ? {
              ...params.hostCapabilities,
              retainSourceAuthority: () => ({
                signal: sourceAbort.signal,
                assertCurrent: () => sourceAbort.signal.throwIfAborted(),
                release: sourceReleased,
              }),
            }
          : params.hostCapabilities,
        (error) => {
          throw error;
        },
        false,
      );
      context.onTestFinished(() => authority.release());
      const commands = new Map<string, string | null>();
      const commandFinished = createDeferred<JsonObject>();
      const peerCommands = new Map<string, string | null>();
      const peerFinished = createDeferred<JsonObject>();
      let collectingCommands = commands;
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
            collectingCommands.set(
              item.id,
              typeof item.processId === "string" ? item.processId : null,
            );
          } else if (notification.method === "item/completed") {
            if (typeof item.id === "string" && commands.has(item.id)) {
              commandFinished.resolve(item);
            }
            if (typeof item.id === "string" && peerCommands.has(item.id)) {
              peerFinished.resolve(item);
            }
          }
        }
      });
      const runTurn = async (threadId: string, source?: CodexNativeProcessAuthority) => {
        const done = createDeferred<JsonObject>();
        completions.set(threadId, done);
        const started = await client.request("turn/start", {
          threadId,
          input: [{ type: "text", text: "Run the native continuation proof.", text_elements: [] }],
        });
        if (source) {
          source.bindTurn(client, threadId, started.turn.id);
        }
        const completed = await done.promise;
        expect(completed.status).toBe("completed");
        return started.turn.id;
      };
      const first = await startOrResumeThread(common);
      const firstTurnId = await runTurn(first.threadId, backgroundWork ? authority : undefined);
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
      if (sourceIsolation) {
        const peerAbort = new AbortController();
        const peerReleased = vi.fn();
        const peer = new CodexNativeProcessAuthority(
          {
            ...params.hostCapabilities,
            retainSourceAuthority: () => ({
              signal: peerAbort.signal,
              assertCurrent: () => peerAbort.signal.throwIfAborted(),
              release: peerReleased,
            }),
          },
          (error) => {
            throw error;
          },
          false,
        );
        context.onTestFinished(() => peer.release());
        try {
          collectingCommands = peerCommands;
          backgroundCallId = "native-peer-command";
          backgroundCommand =
            "echo SOURCE_B_READY; while [ ! -f probe-source-b ]; do /bin/sleep 0.1; done; echo SOURCE_B_ALIVE > source-b-alive; while [ ! -f finish-source-b ]; do /bin/sleep 0.1; done; echo SOURCE_B_DONE";
          backgroundRequested = false;
          const peerTurnId = await runTurn(first.threadId, peer);
          expect(peerTurnId).not.toBe(firstTurnId);
          expect(peerCommands.size).toBe(1);
          const consumePeer = await readCodexRetainedBackgroundCommands({
            client,
            threadId: first.threadId,
            turnId: peerTurnId,
            commands: peerCommands,
            authority: peer,
            assertCurrent: () => peer.assertCurrent(),
            signal: common.signal,
            timeoutMs: 10_000,
          });
          expect(consumePeer().size).toBe(1);
          peer.release();
          const beforeCancel = await client.request("thread/backgroundTerminals/list", {
            threadId: first.threadId,
          });
          const original = beforeCancel.data.find(({ itemId }) => commands.has(itemId));
          const other = beforeCancel.data.find(({ itemId }) => peerCommands.has(itemId));
          if (!original || !other) {
            throw new Error("Both sources must own real live native commands");
          }
          expect(original.processId).not.toBe(other.processId);
          pauseInventory = scenario === "source completion during inventory";
          sourceAbort.abort(new Error("retained source A revoked"));
          expect(sourceReleased).not.toHaveBeenCalled();
          if (scenario === "source completion during inventory") {
            await inventoryEntered.promise;
            expect(inventorySnapshot).toMatchObject({
              data: expect.arrayContaining([
                expect.objectContaining({ itemId: original.itemId, processId: original.processId }),
                expect.objectContaining({ itemId: other.itemId, processId: other.processId }),
              ]),
            });
            await fs.writeFile(path.join(native.cwd, "finish-background"), "finish\n");
            await commandFinished.promise;
            inventoryReleased.resolve();
          } else if (scenario === "source completion before retry") {
            expect(await rejectedIngress.promise).toMatchObject({
              threadId: first.threadId,
              processId: original.processId,
            });
            await fs.writeFile(path.join(native.cwd, "finish-background"), "finish\n");
            await commandFinished.promise;
            if (!releaseRejectedIngress) {
              throw new Error("Missing held ingress rejection");
            }
            releaseRejectedIngress();
          }
          await commandFinished.promise;
          await terminationSettled.promise;
          await vi.waitFor(() => expect(sourceReleased).toHaveBeenCalledOnce());
          expect(authority.commands.size).toBe(0);
          expect(peerReleased).not.toHaveBeenCalled();
          expect(peer.commands.size).toBe(1);
          peer.assertCurrent();
          expect(isCodexAppServerLiveThreadProtected(client, first.threadId)).toBe(true);
          const inventory = await client.request("thread/backgroundTerminals/list", {
            threadId: first.threadId,
          });
          expect(inventory.data.map(({ itemId, processId }) => ({ itemId, processId }))).toEqual([
            { itemId: other.itemId, processId: other.processId },
          ]);
          if (scenario === "source cancellation") {
            await vi.waitFor(() =>
              expect(physicalTerminations).toEqual([
                { threadId: first.threadId, processId: original.processId },
              ]),
            );
          } else {
            expect(terminationFailure).toMatchObject({
              message: "Native command settled before termination",
            });
            expect(physicalTerminations).toEqual([]);
          }
          expect(physicalTerminations.some(({ processId }) => processId === other.processId)).toBe(
            false,
          );
          expect(
            requests
              .slice(before)
              .some(({ method }) => method === "thread/backgroundTerminals/clean"),
          ).toBe(false);
          await expect(
            fs.readFile(path.join(native.cwd, "source-b-alive"), "utf8"),
          ).rejects.toMatchObject({ code: "ENOENT" });
          await fs.writeFile(path.join(native.cwd, "probe-source-b"), "probe\n");
          await vi.waitFor(async () =>
            expect(await fs.readFile(path.join(native.cwd, "source-b-alive"), "utf8")).toBe(
              "SOURCE_B_ALIVE\n",
            ),
          );
          await fs.writeFile(path.join(native.cwd, "finish-source-b"), "finish\n");
          await peerFinished.promise;
          await vi.waitFor(() => expect(peerReleased).toHaveBeenCalledOnce());
          expect(peer.commands.size).toBe(0);
          expect(isCodexAppServerLiveThreadProtected(client, first.threadId)).toBe(false);
          sibling!.assertCurrent();
          await runTurn(siblingBinding.threadId);
          expectNoRequests(["thread/unsubscribe"], siblingBinding.threadId);
          expect(providerFailures).toEqual([]);
          // Synthetic ownership metadata only, never native commands or provider payloads.
          console.info(
            "native-custody-proof",
            JSON.stringify({
              scenario,
              clientId: client.getInstanceId(),
              threadId: first.threadId,
              sourceA: {
                turnId: firstTurnId,
                itemId: original.itemId,
                processId: original.processId,
              },
              sourceB: { turnId: peerTurnId, itemId: other.itemId, processId: other.processId },
              physicalTerminations,
              staleGuardRejected: scenario !== "source cancellation",
              peerHeartbeatAfterSourceASettled: true,
              finalReceipts: { A: true, B: true },
              sourceReleases: {
                A: sourceReleased.mock.calls.length,
                B: peerReleased.mock.calls.length,
              },
            }),
          );
        } finally {
          await Promise.all(
            ["finish-background", "probe-source-b", "finish-source-b"].map((name) =>
              fs.writeFile(path.join(native.cwd, name), "finish\n"),
            ),
          );
          inventoryReleased.resolve();
          releaseRejectedIngress?.();
          await racePromiseWithAbortSignal(
            Promise.all([
              commandFinished.promise,
              ...(peerCommands.size ? [peerFinished.promise] : []),
            ]),
            AbortSignal.timeout(5_000),
          );
        }
        return;
      }
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
          `Codex thread ${first.threadId} still has background work or live resources after waiting for cleanup; wait for them to settle or release the owning resources and retry.`,
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
        ).rejects.toThrow("background work or live resources");
        expect(readBinding()).toEqual(saved);
        expectNoRequests(
          ["thread/start", "thread/unsubscribe", "turn/start"],
          undefined,
          beforePolicyChange,
        );
      }
      const buildsBefore = pluginBuilds;
      if (rotatingAfterCleanup) {
        pluginFingerprint = "changed-policy";
      }
      const continuation = startOrResumeThread(common);
      // Observe rejection immediately too, so a regression cannot leak an unhandled promise.
      const outcome = continuation.catch((error: unknown) => error);
      if (rotatingAfterCleanup) {
        await vi.waitFor(() => expect(pluginBuilds).toBeGreaterThan(buildsBefore));
        await setImmediate();
        expectNoRequests(["thread/start", "thread/unsubscribe", "turn/start"], undefined, before);
        await fs.writeFile(path.join(native.cwd, "finish-background"), "finish\n");
        await expect(commandFinished.promise).resolves.toMatchObject({
          status: "completed",
          exitCode: 0,
        });
      }
      const resumed = await continuation;
      await outcome;
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
      if (rotatingAfterCleanup) {
        expect(
          transitionRequests.filter(
            ({ method, threadId }) =>
              method === "thread/unsubscribe" && threadId === first.threadId,
          ),
        ).toEqual([{ method: "thread/unsubscribe", threadId: first.threadId }]);
      } else if (contextRefresh) {
        expectNoRequests(["thread/unsubscribe"], first.threadId);
      }
      expectNoRequests(["thread/unsubscribe"], siblingBinding.threadId);
      sibling!.assertCurrent();
      await runTurn(siblingBinding.threadId);
      sibling!.assertCurrent();
      if (backgroundWork && !rotatingAfterCleanup) {
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
