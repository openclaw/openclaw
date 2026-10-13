import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  claimCodexAppServerLiveThread,
  isCodexAppServerLiveThreadClaimed,
  isCodexAppServerLiveThreadProtected,
  retainCodexAppServerLiveThread,
} from "./client-runtime.js";
import { createCodexNativeTestState } from "./native-app-server.test-support.js";
import {
  CodexNativeProcessAuthority,
  readCodexRetainedBackgroundCommands,
} from "./native-process-authority.js";
import { isJsonObject, type JsonObject, type JsonValue } from "./protocol.js";
import * as sessionBinding from "./session-binding.js";
import { createCodexSqliteTestBindingStateStore } from "./session-binding.sqlite.test-helpers.js";
import { createIsolatedCodexAppServerClient } from "./shared-client.js";
import { startOrResumeThread } from "./thread-lifecycle-run.js";
import {
  createAppServerOptions,
  createParams,
  resetThreadLifecycleTestFixtures,
} from "./thread-lifecycle.test-fixtures.js";
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
  it.for(["publication failure", "protected rotation"] as const)(
    "%s permits continuation without disturbing sibling ownership",
    { timeout: 90_000 },
    async (scenario, context) => {
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
      const trace: JsonObject[] = [];
      const record = (event: string, fields: Record<string, JsonValue | undefined> = {}) => {
        trace.push({
          sequence: trace.length + 1,
          event,
          ...Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)),
        });
      };
      context.onTestFinished(() => {
        console.log("CODEX_NATIVE_WARM_PROOF", JSON.stringify({ scenario, trace }));
      });
      let backgroundRequested = false;
      let providerRequests = 0;
      const providerFailures: unknown[] = [];
      const server = http.createServer((request, response) => {
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
            const launch = scenario === "protected rotation" && !backgroundRequested;
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
            const events = [
              { type: "response.created", response: { id: `native-response-${providerRequests}` } },
              { type: "response.output_item.done", item },
              {
                type: "response.completed",
                response: {
                  id: `native-response-${providerRequests}`,
                  usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
                },
              },
            ];
            record("loopback-provider-response", { action: launch ? "exec_command" : "answer" });
            response.writeHead(200, { "Content-Type": "text/event-stream" });
            response.end(
              events
                .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
                .join(""),
            );
          } catch (error) {
            providerFailures.push(error);
            response.writeHead(500).end();
          }
        });
      });
      context.onTestFinished(async () => {
        server.closeAllConnections();
        if (server.listening) {
          await new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
          });
        }
      });
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          server.removeListener("error", reject);
          resolve();
        });
      });
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Missing loopback provider address");
      }
      await fs.writeFile(
        path.join(native.codexHome, "config.toml"),
        [
          'model="gpt-5.6-luna"',
          'model_provider="warm-proof"',
          'cli_auth_credentials_store="ephemeral"',
          'web_search="disabled"',
          'approval_policy="never"',
          'sandbox_mode="danger-full-access"',
          "allow_login_shell=false",
          "[features]",
          "code_mode=false",
          "shell_snapshot=false",
          "[analytics]",
          "enabled=false",
          "[feedback]",
          "enabled=false",
          "[model_providers.warm-proof]",
          'name="Loopback native warm proof"',
          `base_url="http://127.0.0.1:${address.port}/v1"`,
          'wire_api="responses"',
          "requires_openai_auth=false",
          "supports_websockets=false",
          "request_max_retries=0",
          "stream_max_retries=0",
        ].join("\n"),
      );
      const childEnv = Object.fromEntries(
        Object.entries(native.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      );
      const appServer = {
        ...createAppServerOptions(),
        sandbox: "danger-full-access" as const,
        start: {
          transport: "stdio" as const,
          command: native.command,
          commandSource: "config" as const,
          args: ["app-server"],
          cwd: native.cwd,
          headers: {},
          env: childEnv,
          clearEnv: Object.keys(process.env).filter((key) => !(key in childEnv)),
        },
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
        record("native-process-exit", { exited: outcome.exited });
        expect(outcome.exited).toBe(true);
      });
      expect(client.getRuntimeIdentity()?.serverVersion).toBe(CODEX_APP_SERVER_VERSION);
      record("native-runtime", {
        version: CODEX_APP_SERVER_VERSION,
        sha256: createHash("sha256")
          .update(await fs.readFile(native.command))
          .digest("hex"),
        operatorCredentials: false,
        provider: "scripted loopback",
      });
      const requests: { method: string; threadId?: string }[] = [];
      const originalRequest = client.request.bind(client);
      vi.spyOn(client, "request").mockImplementation((method, params, options) => {
        const threadId =
          isJsonObject(params) && typeof params.threadId === "string" ? params.threadId : undefined;
        requests.push({ method, threadId });
        record("native-rpc", { method, ...(threadId ? { threadId } : {}) });
        return originalRequest(method, params, options);
      });
      const params = {
        ...createParams(path.join(root, "session.jsonl"), native.cwd),
        agentId: "main",
        agentDir,
        modelId: "gpt-5.6-luna",
        disableTools: false,
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
        appServer,
        userMcpServersEnabled: false,
        signal: AbortSignal.timeout(75_000),
        pluginThreadConfig: {
          enabled: true,
          requiresCurrentPolicyCheck: true,
          inputFingerprint: "stable-input",
          build: async () => ({
            enabled: true,
            fingerprint: pluginFingerprint,
            inputFingerprint: "stable-input",
            diagnostics: [],
            configPatch: {},
            policyContext: { fingerprint: "empty-app-policy", apps: {}, pluginAppIds: {} },
            provisionalAppIds: [],
          }),
        },
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
          record("native-turn-completed", {
            threadId: event.threadId,
            turnId: event.turn.id,
            status: event.turn.status,
          });
          completions.get(event.threadId)?.resolve(event.turn);
        }
        if (
          (notification.method === "item/started" || notification.method === "item/completed") &&
          isJsonObject(event.item) &&
          event.item.type === "commandExecution"
        ) {
          const item = event.item;
          record(notification.method, {
            threadId: event.threadId,
            turnId: event.turnId,
            itemId: item.id,
            processId: item.processId,
            status: item.status,
            exitCode: item.exitCode,
            output: item.aggregatedOutput,
          });
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
      const firstTurnId = await runTurn(first.threadId, scenario === "protected rotation");
      if (scenario === "protected rotation") {
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
        record("native-background-confirmed", { threadId: first.threadId });
      }
      expect(
        await retainCodexAppServerLiveThread(
          client,
          first.threadId,
          undefined,
          first.liveThreadConfigFingerprint,
        ),
      ).toBe(true);
      const siblingParams = {
        ...params,
        sessionId: "sibling",
        sessionKey: "agent:main:sibling",
        sessionFile: path.join(root, "sibling.jsonl"),
      };
      const siblingBinding = await startOrResumeThread({ ...common, params: siblingParams });
      expect(
        await retainCodexAppServerLiveThread(
          client,
          siblingBinding.threadId,
          undefined,
          siblingBinding.liveThreadConfigFingerprint,
        ),
      ).toBe(true);
      const sibling = await claimCodexAppServerLiveThread(client, siblingBinding.threadId);
      expect(sibling).toBeDefined();
      context.onTestFinished(() => sibling?.release(siblingBinding.threadId));
      const before = requests.length;
      const saved = bindingStore.read(sessionBinding.sessionBindingIdentity(params));
      let publicationClaimed = false;
      if (scenario === "publication failure") {
        const resolveBinding = sessionBinding.resolveCodexSessionBinding;
        const readerFailure = new Error("injected warm publication reader settlement failure");
        const fault = vi
          .spyOn(sessionBinding, "resolveCodexSessionBinding")
          .mockImplementationOnce(async (input) => {
            const resolved = await resolveBinding(input);
            const withCurrent = resolved.authority.withCurrent;
            return {
              ...resolved,
              authority: {
                ...resolved.authority,
                withCurrent: async (consume) => {
                  const result = await withCurrent(consume);
                  if (
                    result !== null &&
                    typeof result === "object" &&
                    "liveThreadOwnership" in result &&
                    result.liveThreadOwnership
                  ) {
                    record("warm-publication-fault", { threadId: first.threadId });
                    throw readerFailure;
                  }
                  return result;
                },
              },
            };
          });
        try {
          await expect(startOrResumeThread(common)).rejects.toBe(readerFailure);
        } finally {
          fault.mockRestore();
        }
        publicationClaimed = isCodexAppServerLiveThreadClaimed(client, first.threadId);
        record("failed-publication-claim-state", { claimed: publicationClaimed });
      } else {
        pluginFingerprint = "changed-policy";
        await expect(startOrResumeThread(common)).rejects.toThrow(
          `Codex thread ${first.threadId} is claimed by active work; stop it first.`,
        );
        record("protected-rotation-refused", { threadId: first.threadId });
        expect(bindingStore.read(sessionBinding.sessionBindingIdentity(params))).toEqual(saved);
        pluginFingerprint = "original-policy";
      }
      sibling!.assertCurrent();
      record("sibling-owner-current-after-refusal", { threadId: siblingBinding.threadId });
      const resumed = await startOrResumeThread(common);
      expect(resumed.threadId).toBe(first.threadId);
      expect(resumed.lifecycle.action).toBe("resumed");
      record("warm-retry-prepared", { threadId: resumed.threadId });
      await runTurn(resumed.threadId);
      expect(publicationClaimed).toBe(false);
      const history = await client.request("thread/read", {
        threadId: resumed.threadId,
        includeTurns: true,
      });
      expect(JSON.stringify(history.thread.turns)).toContain("NATIVE_CONTINUATION_OK");
      record("native-continuation-persisted", { threadId: resumed.threadId });
      const transitionRequests = requests.slice(before);
      if (scenario === "protected rotation") {
        expect(
          transitionRequests.some(({ method }) =>
            ["thread/start", "thread/resume", "thread/unsubscribe"].includes(method),
          ),
        ).toBe(false);
      } else {
        expect(transitionRequests).toContainEqual({
          method: "thread/unsubscribe",
          threadId: first.threadId,
        });
        expect(transitionRequests).toContainEqual({
          method: "thread/resume",
          threadId: first.threadId,
        });
      }
      expect(
        transitionRequests.some(
          ({ method, threadId }) =>
            method === "thread/unsubscribe" && threadId === siblingBinding.threadId,
        ),
      ).toBe(false);
      sibling!.assertCurrent();
      await runTurn(siblingBinding.threadId);
      sibling!.assertCurrent();
      record("sibling-owner-current-after-native-turn", { threadId: siblingBinding.threadId });
      if (scenario === "protected rotation") {
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
        record("background-survived-continuation", {
          threadId: first.threadId,
          itemId: background.itemId,
          processId: background.processId,
        });
        await fs.writeFile(path.join(native.cwd, "finish-background"), "finish\n");
        await expect(commandFinished.promise).resolves.toMatchObject({
          status: "completed",
          exitCode: 0,
          aggregatedOutput: expect.stringContaining("BACKGROUND_DONE"),
        });
        expect(isCodexAppServerLiveThreadProtected(client, first.threadId)).toBe(false);
        expect(authority.commands.size).toBe(0);
        record("background-settled-successfully", { threadId: first.threadId });
      }
      expect(client.getCloseError()).toBeUndefined();
      expect(providerFailures).toEqual([]);
      await resumed.liveThreadOwnership?.release(resumed.threadId);
      record("proof-complete", { providerRequests, siblingIntact: true });
    },
  );
});
