import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { startQaGatewayChild } from "./gateway-child.js";
import { startQaMockOpenAiServer } from "./providers/mock-openai/server.js";

const RECOVERED_MARKER = "GATEWAY-RECOVERY-OK";
const RECOVERY_PROMPT = "final-only marker streaming qa check; reply exactly `GATEWAY-RECOVERY-OK`";

type RecoveryStep = {
  method: "agent" | "agent.wait";
  replayOnly?: boolean;
};

type RecoveryProxy = {
  capture: {
    droppedAcceptedConnection: boolean;
    droppedRecoverySteps: RecoveryStep[];
    steps: RecoveryStep[];
  };
  stop: () => Promise<void>;
  url: string;
};

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

function parseJsonFrame(data: RawData): Record<string, unknown> | null {
  try {
    const text = Array.isArray(data)
      ? Buffer.concat(data.map((chunk) => Buffer.from(chunk))).toString("utf8")
      : Buffer.isBuffer(data)
        ? data.toString("utf8")
        : Buffer.from(data).toString("utf8");
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

async function startRecoveryProxy(
  upstreamUrl: string,
  opts: { exhaustRecovery?: boolean } = {},
): Promise<RecoveryProxy> {
  const capture: RecoveryProxy["capture"] = {
    droppedAcceptedConnection: false,
    droppedRecoverySteps: [],
    steps: [],
  };
  let disconnectArmed = false;
  const server: Server = createServer();
  const wss = new WebSocketServer({ server });
  wss.on("connection", (downstream) => {
    const upstream = new WebSocket(upstreamUrl);
    const pending: RawData[] = [];
    let disconnectRequestId: string | undefined;

    downstream.on("message", (data) => {
      const frame = parseJsonFrame(data);
      const params = frame?.params as Record<string, unknown> | undefined;
      if (frame?.method === "agent" || frame?.method === "agent.wait") {
        const step: RecoveryStep = {
          method: frame.method,
          ...(frame.method === "agent" ? { replayOnly: params?.replayOnly === true } : {}),
        };
        capture.steps.push(step);
        if (
          opts.exhaustRecovery === true &&
          disconnectArmed &&
          (frame.method === "agent.wait" || params?.replayOnly === true)
        ) {
          // Drop each recovery RPC after a successful handshake so the CLI exhausts
          // the real wait/replay path before starting its isolated embedded fallback.
          capture.droppedRecoverySteps.push(step);
          downstream.terminate();
          upstream.terminate();
          return;
        }
      }
      if (
        !disconnectArmed &&
        frame?.method === "agent" &&
        params?.replayOnly !== true &&
        typeof frame.id === "string"
      ) {
        disconnectArmed = true;
        disconnectRequestId = frame.id;
      }
      if (upstream.readyState === WebSocket.OPEN) {
        upstream.send(data);
      } else {
        pending.push(data);
      }
    });
    upstream.on("open", () => {
      for (const data of pending.splice(0)) {
        upstream.send(data);
      }
    });
    upstream.on("message", (data) => {
      const frame = parseJsonFrame(data);
      const payload = frame?.payload as Record<string, unknown> | undefined;
      if (
        !capture.droppedAcceptedConnection &&
        frame?.id === disconnectRequestId &&
        payload?.status === "accepted"
      ) {
        downstream.send(data, (error) => {
          if (error) {
            downstream.terminate();
            return;
          }
          // Let the CLI observe acceptance before simulating an uncertain transport loss.
          setTimeout(() => {
            capture.droppedAcceptedConnection = true;
            downstream.terminate();
          }, 25);
        });
        return;
      }
      if (downstream.readyState === WebSocket.OPEN) {
        downstream.send(data);
      }
    });
    const closeDownstream = () => {
      if (downstream.readyState === WebSocket.OPEN) {
        downstream.terminate();
      }
    };
    upstream.on("error", closeDownstream);
    upstream.on("close", closeDownstream);
    downstream.on("close", () => upstream.close());
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Gateway recovery proxy did not bind a TCP port");
  }
  return {
    capture,
    url: `ws://127.0.0.1:${address.port}`,
    async stop() {
      for (const client of wss.clients) {
        client.terminate();
      }
      await new Promise<void>((resolve) => {
        wss.close(() => resolve());
      });
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}

async function readMockRequestCount(baseUrl: string): Promise<number> {
  const requests = await fetch(`${baseUrl}/debug/requests`).then((response) => response.json());
  if (!Array.isArray(requests)) {
    throw new Error(`Mock provider returned invalid request log: ${JSON.stringify(requests)}`);
  }
  return requests.length;
}

describe("agent Gateway recovery", () => {
  it("recovers a terminal result after accepted disconnect without starting duplicate work", async () => {
    const mock = await startQaMockOpenAiServer({ finalOnlyMarkerPauseMs: 2_000 });
    cleanups.push(() => mock.stop());
    const gateway = await startQaGatewayChild({
      repoRoot: process.cwd(),
      useRepoCli: true,
      providerBaseUrl: `${mock.baseUrl}/v1`,
      providerMode: "mock-openai",
      transportBaseUrl: "http://127.0.0.1",
      controlUiEnabled: false,
      runtimeEnvPatch: { OPENCLAW_TEST_RUNTIME_LOG: "1" },
    });
    cleanups.push(() => gateway.stop());
    const proxy = await startRecoveryProxy(gateway.wsUrl);
    cleanups.push(() => proxy.stop());
    gateway.runtimeEnv.OPENCLAW_GATEWAY_URL = proxy.url;

    const output = await gateway.runCli([
      "agent",
      "--agent",
      "qa",
      "--message",
      RECOVERY_PROMPT,
      "--json",
      "--timeout",
      "30",
    ]);
    expect(output).toContain(RECOVERED_MARKER);
    expect(proxy.capture.droppedAcceptedConnection).toBe(true);
    expect(proxy.capture.steps).toEqual([
      { method: "agent", replayOnly: false },
      { method: "agent.wait" },
      { method: "agent", replayOnly: true },
    ]);
    const providerRequestsAfterRecovery = await readMockRequestCount(mock.baseUrl);
    expect(providerRequestsAfterRecovery).toBe(1);

    const cacheMissRunId = `qa-cache-miss-${randomUUID()}`;
    await expect(
      gateway.call(
        "agent",
        {
          message: "cache-only recovery must not start this turn",
          agentId: "qa",
          idempotencyKey: cacheMissRunId,
          replayOnly: true,
        },
        { expectFinal: true, timeoutMs: 10_000 },
      ),
    ).rejects.toThrow(/No cached agent result.+did not start a new run/s);
    expect(await readMockRequestCount(mock.baseUrl)).toBe(providerRequestsAfterRecovery);

    console.info(
      [
        "PROOF setup=real-cli+real-gateway+websocket-fault-proxy+mock-model-provider",
        "PROOF disconnect=after-agent-accepted",
        "PROOF rpc-sequence=agent -> agent.wait -> agent(replayOnly=true)",
        `PROOF recovered-output=${RECOVERED_MARKER}`,
        `PROOF provider-requests=${providerRequestsAfterRecovery}`,
        "PROOF cache-miss=AGENT_RESULT_NOT_FOUND",
        "PROOF cache-miss-provider-delta=0",
      ].join("\n"),
    );
  }, 180_000);

  it("uses an isolated embedded fallback after wait and replay recovery are exhausted", async () => {
    const mock = await startQaMockOpenAiServer({ finalOnlyMarkerPauseMs: 2_000 });
    cleanups.push(() => mock.stop());
    const gateway = await startQaGatewayChild({
      repoRoot: process.cwd(),
      useRepoCli: true,
      providerBaseUrl: `${mock.baseUrl}/v1`,
      providerMode: "mock-openai",
      transportBaseUrl: "http://127.0.0.1",
      controlUiEnabled: false,
      runtimeEnvPatch: { OPENCLAW_TEST_RUNTIME_LOG: "1" },
    });
    cleanups.push(() => gateway.stop());
    const proxy = await startRecoveryProxy(gateway.wsUrl, { exhaustRecovery: true });
    cleanups.push(() => proxy.stop());
    gateway.runtimeEnv.OPENCLAW_GATEWAY_URL = proxy.url;

    const output = await gateway.runCli([
      "agent",
      "--agent",
      "qa",
      "--message",
      RECOVERY_PROMPT,
      "--json",
      "--timeout",
      "30",
    ]);
    const result = JSON.parse(output) as {
      meta?: {
        fallbackFrom?: string;
        fallbackReason?: string;
        fallbackSessionId?: string;
        fallbackSessionKey?: string;
        transport?: string;
      };
      payloads?: Array<{ text?: string }>;
    };
    expect(result.payloads?.some((payload) => payload.text?.includes(RECOVERED_MARKER))).toBe(true);
    expect(result.meta).toMatchObject({
      transport: "embedded",
      fallbackFrom: "gateway",
      fallbackReason: "gateway_closed",
    });
    expect(result.meta?.fallbackSessionId).toMatch(/^gateway-fallback-/);
    expect(result.meta?.fallbackSessionKey).toBe(
      `agent:qa:explicit:${result.meta?.fallbackSessionId}`,
    );
    expect(proxy.capture.droppedAcceptedConnection).toBe(true);
    expect(proxy.capture.steps).toEqual([
      { method: "agent", replayOnly: false },
      { method: "agent.wait" },
      { method: "agent", replayOnly: true },
    ]);
    expect(proxy.capture.droppedRecoverySteps).toEqual([
      { method: "agent.wait" },
      { method: "agent", replayOnly: true },
    ]);
    const providerRequests = await readMockRequestCount(mock.baseUrl);
    expect(providerRequests).toBe(2);

    console.info(
      [
        "PROOF exhaustion-setup=real-cli+real-gateway+websocket-fault-proxy+mock-model-provider",
        "PROOF exhaustion-disconnect=after-agent-accepted",
        "PROOF exhaustion-rpc-sequence=agent -> agent.wait(drop) -> agent(replayOnly=true,drop)",
        "PROOF exhaustion-fallback-transport=embedded",
        "PROOF exhaustion-fallback-session=gateway-fallback-*",
        `PROOF exhaustion-output=${RECOVERED_MARKER}`,
        `PROOF exhaustion-provider-requests=${providerRequests}`,
      ].join("\n"),
    );
  }, 180_000);
});
