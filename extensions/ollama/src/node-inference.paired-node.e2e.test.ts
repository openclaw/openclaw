import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { text } from "node:stream/consumers";
import { GatewayClient } from "openclaw/plugin-sdk/gateway-runtime";
import { acquireTestPortBlock, stopChildProcess, withServer } from "openclaw/plugin-sdk/test-env";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { expect, it, onTestFinished, vi } from "vitest";
import { createOllamaNodeHostCommands } from "./node-inference.js";

const STARTUP_TIMEOUT_MS = 60_000;
// Reserve ten seconds each for readiness, inference, and cleanup.
const PHASE_TIMEOUT_MS = 10_000;
const NODE_DISPLAY_NAME = "paired-ollama-e2e";
const NODE_MODEL = "node-local:latest";
const LOADED_NODE_MODEL = "loaded-node-local:latest";
type FakeOllama = { baseUrl: string; chatRequests: Record<string, unknown>[] };
type PairedNode = {
  nodeId: string;
  displayName?: string;
  connected?: boolean;
};
type NodeInvokeFrame = {
  id?: string;
  nodeId?: string;
  command?: string;
  params?: unknown;
  paramsJSON?: string | null;
};

it(
  "routes authenticated Ollama discovery and chat over the actual paired node socket",
  { timeout: 90_000 },
  async () => {
    await withOllama("node", (nodeOllama) =>
      withOllama("gateway", (gatewayOllama) => runInference(nodeOllama, gatewayOllama)),
    );
  },
);

async function runInference(nodeOllama: FakeOllama, gatewayOllama: FakeOllama) {
  const state = await createOpenClawTestState({
    label: "ollama-paired-node-e2e",
    layout: "home",
  });
  const portClaim = await acquireTestPortBlock({ offsets: [0] });
  onTestFinished(portClaim.release);
  const gatewayPort = portClaim.port;
  const gatewayToken = `ollama-e2e-${randomUUID()}`;
  const logs: string[] = [];
  const handlerErrors: unknown[] = [];
  const commands = createOllamaNodeHostCommands({ baseUrl: nodeOllama.baseUrl });
  let gateway: ChildProcessWithoutNullStreams | undefined;
  let operator: GatewayClient | undefined;
  let node: GatewayClient | undefined;
  try {
    await state.writeConfig({
      cron: { enabled: false },
      gateway: {
        mode: "local",
        port: gatewayPort,
        bind: "loopback",
        auth: { mode: "token", token: gatewayToken },
        controlUi: { enabled: false },
        nodes: { commands: { allow: ["ollama.models", "ollama.chat"] } },
      },
      plugins: { allow: ["ollama"] },
      agents: { defaults: { skipBootstrap: true } },
      models: {
        providers: { ollama: { api: "ollama", baseUrl: gatewayOllama.baseUrl, models: [] } },
      },
    });
    const gatewayEntry =
      process.env.OPENCLAW_E2E_USE_PREBUILT_DIST === "1"
        ? ["dist/entry.js"]
        : ["--import", "tsx", "src/entry.ts"];
    gateway = spawn(process.execPath, [...gatewayEntry, "gateway", "--allow-unconfigured"], {
      cwd: process.cwd(),
      stdio: "pipe",
      env: {
        ...state.env,
        OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(process.cwd(), "extensions"),
        OPENCLAW_GATEWAY_TOKEN: gatewayToken,
        OPENCLAW_GATEWAY_PORT: String(gatewayPort),
        OPENCLAW_CLI: "1",
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "0",
        OPENCLAW_GATEWAY_STARTUP_TRACE: "1",
        OPENCLAW_NO_RESPAWN: "1",
        OPENCLAW_TEST_FAST: "1",
        OPENCLAW_TEST_MINIMAL_GATEWAY: "1",
        OPENCLAW_SKIP_CHANNELS: "1",
        OPENCLAW_SKIP_PROVIDERS: "0",
        OPENCLAW_SKIP_GMAIL_WATCHER: "1",
        OPENCLAW_SKIP_CRON: "1",
        OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
        OPENCLAW_SKIP_CANVAS_HOST: "1",
        OPENCLAW_SKIP_STARTUP_MODEL_PREWARM: "1",
        OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
      },
    });
    const appendLog = (chunk: string) => {
      logs.push(chunk);
      if (logs.length > 32) {
        logs.shift();
      }
    };
    for (const stream of [gateway.stdout, gateway.stderr]) {
      stream.setEncoding("utf8");
      stream.on("data", appendLog);
    }
    gateway.once("error", (error) => appendLog(error.message));
    // An authenticated hello proves readiness more strongly than /healthz.
    let readinessDeadline = performance.now() + STARTUP_TIMEOUT_MS;
    async function connect(
      role: "operator" | "node",
      onEvent?: ConstructorParameters<typeof GatewayClient>[0]["onEvent"],
    ) {
      const isNode = role === "node";
      const { promise, resolve, reject } = Promise.withResolvers<GatewayClient>();
      const client = new GatewayClient({
        url: `ws://127.0.0.1:${gatewayPort}`,
        token: gatewayToken,
        role,
        clientName: isNode ? "node-host" : "test",
        clientDisplayName: isNode ? NODE_DISPLAY_NAME : "ollama-paired-node-e2e",
        clientVersion: "1.0.0",
        platform: isNode ? "macos" : process.platform,
        mode: isNode ? "node" : "test",
        scopes: isNode
          ? []
          : ["operator.admin", "operator.pairing", "operator.read", "operator.write"],
        caps: isNode ? ["local-inference"] : undefined,
        commands: isNode ? commands.map((command) => command.command) : undefined,
        requestTimeoutMs: PHASE_TIMEOUT_MS,
        onEvent,
        onHelloOk: () => resolve(client),
        onConnectError: reject,
        onClose: (code, reason) => reject(new Error(`Gateway closed (${code}): ${reason}`)),
      });
      const timer = setTimeout(
        () => reject(new Error("Gateway client connection timed out")),
        Math.min(5_000, remainingMs(readinessDeadline)),
      );
      timer.unref();
      client.start();
      try {
        return await promise;
      } catch (error) {
        client.stop();
        throw error;
      } finally {
        clearTimeout(timer);
      }
    }
    const control = (operator = await vi.waitFor(() => connect("operator"), {
      timeout: remainingMs(readinessDeadline),
      interval: 250,
    }));
    readinessDeadline = performance.now() + PHASE_TIMEOUT_MS;
    async function approvePending() {
      for (const owner of ["device", "node"]) {
        const request = <T>(method: string, params = {}) =>
          control.request<T>(`${owner}.pair.${method}`, params, {
            timeoutMs: remainingMs(readinessDeadline),
          });
        const result = await request<{ pending?: Array<{ requestId?: string }> }>("list");
        for (const pending of result.pending ?? []) {
          if (pending.requestId) {
            await request("approve", { requestId: pending.requestId });
          }
        }
      }
    }
    const onEvent: ConstructorParameters<typeof GatewayClient>[0]["onEvent"] = (event) => {
      if (event.event !== "node.invoke.request") {
        return;
      }
      void respond(event.payload).catch((error: unknown) => handlerErrors.push(error));
    };
    async function respond(payload: unknown) {
      const frame = payload as NodeInvokeFrame;
      const command = commands.find((entry) => entry.command === frame.command);
      if (!node || !frame.id || !frame.nodeId || !command) {
        throw new Error("Gateway sent an invalid or unauthorized Ollama node invocation");
      }
      const paramsJSON =
        frame.paramsJSON ?? (frame.params === undefined ? null : JSON.stringify(frame.params));
      const identity = { id: frame.id, nodeId: frame.nodeId };
      try {
        const payloadJSON = await command.handle(paramsJSON);
        await node.request("node.invoke.result", { ...identity, ok: true, payloadJSON });
      } catch (error) {
        await node.request("node.invoke.result", {
          ...identity,
          ok: false,
          error: {
            code: "UNAVAILABLE",
            message: error instanceof Error ? error.message : String(error),
          },
        });
      }
    }
    try {
      node = await connect("node", onEvent);
    } catch (error) {
      if ((error as { details?: { code?: string } }).details?.code !== "PAIRING_REQUIRED") {
        throw error;
      }
      // Approve the isolated device's real role upgrade, not a synthetic bypass.
      await approvePending();
      node = await connect("node", onEvent);
    }
    const pairedNode = await vi.waitFor(
      async () => {
        await approvePending();
        const result = await control.request<{ nodes?: PairedNode[] }>(
          "node.list",
          {},
          { timeoutMs: remainingMs(readinessDeadline) },
        );
        const paired = result.nodes?.find(
          (entry) => entry.displayName === NODE_DISPLAY_NAME && entry.connected,
        );
        if (!paired) {
          throw new Error("Ollama-capable paired node never connected");
        }
        return paired;
      },
      { timeout: remainingMs(readinessDeadline), interval: 100 },
    );
    const inferenceDeadline = performance.now() + PHASE_TIMEOUT_MS;
    const rejected = await fetch(`http://127.0.0.1:${gatewayPort}/tools/invoke`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer not-the-gateway-token",
      },
      body: JSON.stringify({ tool: "node_inference", args: { action: "discover" } }),
      signal: AbortSignal.timeout(remainingMs(inferenceDeadline)),
    });
    expect(rejected.status).toBe(401);
    const invoke = async (
      command: string,
      params: Record<string, unknown>,
      timeoutMs = remainingMs(inferenceDeadline),
    ) => {
      const result = await control.request(
        "node.invoke",
        {
          nodeId: pairedNode.nodeId,
          command,
          params,
          timeoutMs,
          idempotencyKey: randomUUID(),
        },
        { timeoutMs },
      );
      expect(result).toMatchObject({ ok: true, nodeId: pairedNode.nodeId, command });
      return result.payload;
    };
    expect(await invoke("ollama.models", {})).toMatchObject({
      provider: "ollama",
      models: [
        expect.objectContaining({ name: LOADED_NODE_MODEL, loaded: true }),
        expect.objectContaining({ name: NODE_MODEL, loaded: false }),
      ],
    });
    const timeoutMs = remainingMs(inferenceDeadline);
    expect(
      await invoke(
        "ollama.chat",
        {
          model: NODE_MODEL,
          prompt: "Reply exactly with PAIRED_NODE_OK",
          maxTokens: 16,
          timeoutMs,
        },
        timeoutMs,
      ),
    ).toMatchObject({
      provider: "ollama",
      model: NODE_MODEL,
      response: "PAIRED_NODE_OK",
      usage: { promptTokens: 8, completionTokens: 3 },
    });
    expect(handlerErrors).toEqual([]);
    expect(nodeOllama.chatRequests).toEqual([expect.objectContaining({ model: NODE_MODEL })]);
    expect(gatewayOllama.chatRequests).toEqual([]);
  } catch (error) {
    throw new Error(`Ollama paired-node Gateway failed:\n${logs.join("")}`, { cause: error });
  } finally {
    await Promise.allSettled(
      [node, operator].flatMap((client) =>
        client ? [client.stopAndWait({ timeoutMs: 1000 })] : [],
      ),
    );
    if (gateway) {
      await stopChildProcess(gateway, 2_000).catch(async (error: unknown) => {
        // Join state work before restoring selectors if the child retains its files.
        await state.restoreEnv();
        throw error;
      });
    }
    await state.cleanup();
  }
}

function remainingMs(deadline: number): number {
  const remaining = Math.ceil(deadline - performance.now());
  if (remaining <= 0) {
    throw new Error("Ollama paired-node E2E phase exceeded its deadline");
  }
  return remaining;
}

async function withOllama(owner: "node" | "gateway", run: (server: FakeOllama) => Promise<void>) {
  const chatRequests: Record<string, unknown>[] = [];
  const send = (response: ServerResponse, body: unknown): void => {
    response.end(JSON.stringify(body));
  };
  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/tags") {
      return send(response, {
        models:
          owner === "node"
            ? [
                { name: "remote:cloud", remote_host: "https://ollama.com" },
                ...Array.from({ length: 200 }, (_, index) => ({
                  name: `embedding-${index}:latest`,
                })),
                { name: NODE_MODEL, size: 600 },
                { name: LOADED_NODE_MODEL, size: 1200 },
              ]
            : [{ name: "gateway-remote:latest" }],
      });
    }
    if (request.url === "/api/ps") {
      return send(response, { models: [{ name: LOADED_NODE_MODEL }] });
    }
    if (request.url === "/api/show" || request.url === "/api/chat") {
      const body = JSON.parse(await text(request)) as Record<string, unknown>;
      if (request.url === "/api/show") {
        if (typeof body.model !== "string" || !body.model) {
          response.statusCode = 400;
          return send(response, { error: "model is required" });
        }
        const embedding = body.model.startsWith("embedding-");
        return send(response, {
          capabilities: embedding ? ["embedding"] : ["completion", "tools"],
          model_info: embedding ? {} : { "test.context_length": 32_768 },
        });
      }
      chatRequests.push(body);
      return send(response, {
        model: body.model,
        message: { content: owner === "node" ? "PAIRED_NODE_OK" : "WRONG_GATEWAY_ENDPOINT" },
        done_reason: "stop",
        prompt_eval_count: 8,
        eval_count: 3,
      });
    }
    response.statusCode = 404;
    send(response, { error: "not found" });
  };
  await withServer(
    (request, response) => {
      void handle(request, response).catch((error: unknown) => {
        response.statusCode = 500;
        send(response, { error: String(error) });
      });
    },
    (baseUrl) => run({ baseUrl, chatRequests }),
  );
}
