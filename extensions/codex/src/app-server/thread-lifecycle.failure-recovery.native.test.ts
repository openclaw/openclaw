import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { acquireTestPortBlock, useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it, vi } from "vitest";
import { claimCodexAppServerLiveThread, retainCodexAppServerLiveThread } from "./client-runtime.js";
import { createCodexNativeTestState } from "./native-app-server.test-support.js";
import { isJsonObject, type JsonObject } from "./protocol.js";
import { createCodexAppServerBindingStore, sessionBindingIdentity } from "./session-binding.js";
import { createCodexSqliteTestBindingStateStore } from "./session-binding.sqlite.test-helpers.js";
import {
  getLeasedSharedCodexAppServerClient,
  releaseLeasedSharedCodexAppServerClient,
} from "./shared-client.js";
import { startOrResumeThread } from "./thread-lifecycle-run.js";
import {
  createAppServerOptions,
  createParams,
  resetThreadLifecycleTestFixtures,
} from "./thread-lifecycle.test-fixtures.js";

vi.unmock("node:child_process");
afterEach(() => {
  resetThreadLifecycleTestFixtures();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

// Real native unload and configuration receipts are the boundary: a fake server
// that unloads on unsubscribe would conceal the retained systemError regression.
it(
  "recovers a rate-limited native thread while its shared sibling keeps running",
  {
    timeout: 60_000,
  },
  async (context) => {
    const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
      context.onTestFinished(async () => {
        await closeOpenClawStateDatabaseAsync();
        cleanup();
      }),
    );
    const root = await fs.realpath(tempDirs.make("codex-failed-thread-"));
    const native = await createCodexNativeTestState(root);
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
    vi.stubEnv("HOME", native.env.HOME);
    vi.stubEnv("CODEX_HOME", native.codexHome);
    const siblingResponse = createDeferred<http.ServerResponse>();
    let foregroundRequests = 0;
    let siblingRequests = 0;
    const providerErrors: unknown[] = [];
    const completeResponse = (response: http.ServerResponse, id: string, text: string) => {
      const events = [
        { type: "response.created", response: { id } },
        {
          type: "response.output_item.done",
          item: {
            type: "message",
            role: "assistant",
            id: `${id}-message`,
            content: [{ type: "output_text", text }],
          },
        },
        {
          type: "response.completed",
          response: { id, usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } },
        },
      ];
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
    };
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
          if (body.includes("hold-sibling-response")) {
            siblingRequests += 1;
            siblingResponse.resolve(response);
            return;
          }
          foregroundRequests += 1;
          if (foregroundRequests === 1) {
            response.writeHead(429, { "Content-Type": "application/json" });
            response.end(
              JSON.stringify({
                error: { message: "Synthetic rate limit", type: "rate_limit_error" },
              }),
            );
            return;
          }
          completeResponse(response, "recovered-response", "RECOVERY_OK");
        } catch (error) {
          providerErrors.push(error);
          response.writeHead(500).end();
        }
      });
    });
    const port = await acquireTestPortBlock({ offsets: [0] });
    context.onTestFinished(async () => {
      server.closeAllConnections();
      if (server.listening) {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
      await port.release();
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port.port, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    await fs.writeFile(
      path.join(native.codexHome, "config.toml"),
      [
        'model="fixture-model"',
        'model_provider="recovery-fixture"',
        'cli_auth_credentials_store="ephemeral"',
        'web_search="disabled"',
        'approval_policy="never"',
        'sandbox_mode="read-only"',
        "allow_login_shell=false",
        "[features]",
        "shell_snapshot=false",
        "[analytics]",
        "enabled=false",
        "[feedback]",
        "enabled=false",
        "[model_providers.recovery-fixture]",
        'name="Synthetic loopback recovery provider"',
        `base_url="http://127.0.0.1:${port.port}/v1"`,
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
      sandbox: "read-only" as const,
      start: {
        transport: "stdio" as const,
        command: native.command,
        commandSource: "resolved-managed" as const,
        args: ["app-server"],
        cwd: native.cwd,
        headers: {},
        env: childEnv,
        clearEnv: Object.keys(process.env).filter((key) => !(key in childEnv)),
      },
    };
    const agentDir = path.join(root, "agent");
    const acquireOptions = {
      startOptions: appServer.start,
      agentDir,
      authProfileId: null,
      config: {},
      timeoutMs: 20_000,
    };
    const client = await getLeasedSharedCodexAppServerClient(acquireOptions);
    context.onTestFinished(async () => {
      releaseLeasedSharedCodexAppServerClient(client);
      expect(await client.closeAndWait()).toMatchObject({ exited: true });
    });
    const siblingClient = await getLeasedSharedCodexAppServerClient(acquireOptions);
    context.onTestFinished(() => {
      releaseLeasedSharedCodexAppServerClient(siblingClient);
    });
    expect(siblingClient).toBe(client);
    const completions = new Map<string, ReturnType<typeof createDeferred<JsonObject>>>();
    const unloaded: string[] = [];
    context.onTestFinished(
      client.addNotificationHandler((notification) => {
        if (
          !isJsonObject(notification.params) ||
          typeof notification.params.threadId !== "string"
        ) {
          return;
        }
        const event = notification.params;
        if (notification.method === "turn/completed" && isJsonObject(event.turn)) {
          completions.get(notification.params.threadId)?.resolve(event.turn);
        }
        if (
          notification.method === "thread/status/changed" &&
          isJsonObject(event.status) &&
          event.status.type === "notLoaded"
        ) {
          unloaded.push(notification.params.threadId);
        }
      }),
    );
    const params = {
      ...createParams(path.join(root, "session.jsonl"), native.cwd),
      agentId: "main",
      agentDir,
      modelId: "fixture-model",
    };
    const bindingStore = createCodexAppServerBindingStore(
      createCodexSqliteTestBindingStateStore({
        namespace: "native-failure-recovery",
        maxEntries: 32,
        env: { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") },
      }),
    );
    const common = {
      client,
      bindingStore,
      params,
      cwd: native.cwd,
      dynamicTools: [],
      appServer,
      userMcpServersEnabled: false,
      signal: AbortSignal.timeout(45_000),
    };
    const first = await startOrResumeThread(common);
    const failed = createDeferred<JsonObject>();
    completions.set(first.threadId, failed);
    await client.request("turn/start", {
      threadId: first.threadId,
      input: [{ type: "text", text: "Preserve this failed user request.", text_elements: [] }],
    });
    await expect(failed.promise).resolves.toMatchObject({ status: "failed" });
    expect(
      (await client.request("thread/read", { threadId: first.threadId, includeTurns: false }))
        .thread.status,
    ).toMatchObject({ type: "systemError" });
    expect(await retainCodexAppServerLiveThread(client, first.threadId)).toBe(true);
    const sibling = await client.request("thread/start", {
      cwd: native.cwd,
      model: "fixture-model",
      modelProvider: "recovery-fixture",
      approvalPolicy: "never",
      sandbox: "read-only",
    });
    const siblingOwner = await claimCodexAppServerLiveThread(client, sibling.thread.id);
    expect(siblingOwner).toBeDefined();
    context.onTestFinished(async () => {
      await siblingOwner?.release(sibling.thread.id);
    });
    const siblingCompleted = createDeferred<JsonObject>();
    completions.set(sibling.thread.id, siblingCompleted);
    const siblingTurn = await client.request("turn/start", {
      threadId: sibling.thread.id,
      input: [{ type: "text", text: "hold-sibling-response", text_elements: [] }],
    });
    const heldResponse = await siblingResponse.promise;

    const recovered = await startOrResumeThread(common);
    expect(recovered.threadId).toBe(first.threadId);
    expect(bindingStore.read(sessionBindingIdentity(params))?.threadId).toBe(first.threadId);
    expect(unloaded).toContain(first.threadId);
    expect(client.getCloseError()).toBeUndefined();
    expect(
      (await client.request("thread/read", { threadId: sibling.thread.id, includeTurns: false }))
        .thread.status,
    ).toMatchObject({ type: "active" });
    const recoveredCompleted = createDeferred<JsonObject>();
    completions.set(first.threadId, recoveredCompleted);
    await client.request("turn/start", {
      threadId: first.threadId,
      input: [{ type: "text", text: "Continue the preserved conversation.", text_elements: [] }],
    });
    await expect(recoveredCompleted.promise).resolves.toMatchObject({ status: "completed" });
    const history = await client.request("thread/read", {
      threadId: first.threadId,
      includeTurns: true,
    });
    expect(JSON.stringify(history.thread.turns)).toContain("Preserve this failed user request.");
    expect(JSON.stringify(history.thread.turns)).toContain("RECOVERY_OK");
    completeResponse(heldResponse, "sibling-response", "SIBLING_OK");
    await expect(siblingCompleted.promise).resolves.toMatchObject({
      id: siblingTurn.turn.id,
      status: "completed",
    });
    expect(foregroundRequests).toBe(2);
    expect(siblingRequests).toBe(1);
    expect(providerErrors).toEqual([]);
  },
);
