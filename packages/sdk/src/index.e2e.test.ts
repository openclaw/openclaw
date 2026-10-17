import type { AddressInfo } from "node:net";
import net from "node:net";
import { rawDataToString } from "@openclaw/gateway-client/websocket-data";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { installGatewayTestHooks, startServer } from "../../../src/gateway/test-helpers.js";
import { emitAgentEvent } from "../../../src/infra/agent-events.js";
import {
  clearAgentRunContext,
  registerAgentRunContext,
} from "../../../src/infra/agent-run-registry.js";
import { withTimeout } from "../../../src/utils/with-timeout.js";
import { GatewayClientTransport, OpenClaw, type OpenClawEvent } from "./index.js";

type JsonObject = Record<string, unknown>;
type FakeGatewayRequest = {
  id: string;
  method: string;
  params?: unknown;
};
type FakeGateway = {
  url: string;
  requests: FakeGatewayRequest[];
  close: () => Promise<void>;
};

const servers: WebSocketServer[] = [];

function expectJsonObject(value: unknown): JsonObject {
  expect(value && typeof value).toBe("object");
  return value as JsonObject;
}

async function expectResponse(response: Promise<unknown>, fields: JsonObject) {
  const value = expectJsonObject(await response);
  for (const [key, expected] of Object.entries(fields)) {
    expect(value[key]).toEqual(expected);
  }
}

function sendJson(socket: WebSocket, payload: JsonObject): void {
  socket.send(JSON.stringify(payload));
}

async function reservePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

async function createFakeGateway(port = 0): Promise<FakeGateway> {
  const server = new WebSocketServer({ host: "127.0.0.1", port });
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.once("listening", resolve);
  });
  let seq = 1;
  const requests: FakeGatewayRequest[] = [];
  server.on("connection", (socket) => {
    socket.binaryType = "nodebuffer";
    sendJson(socket, {
      type: "event",
      event: "connect.challenge",
      seq: seq++,
      payload: { nonce: "sdk-e2e-nonce", ts: Date.now() },
    });

    socket.on("message", (raw) => {
      const frame = JSON.parse(rawDataToString(raw)) as FakeGatewayRequest;
      requests.push(frame);
      const reply = (payload: JsonObject): void => {
        sendJson(socket, { type: "res", id: frame.id, ok: true, payload });
      };

      if (frame.method === "connect") {
        reply({
          type: "hello-ok",
          protocol: 1,
          server: { version: "sdk-e2e", connId: "conn-sdk-e2e" },
          features: {
            methods: [
              "agent",
              "agent.wait",
              "agent.identity.get",
              "agents.create",
              "agents.delete",
              "agents.list",
              "agents.update",
              "connect",
              "exec.approval.list",
              "exec.approval.resolve",
              "models.authStatus",
              "models.list",
              "sessions.abort",
              "sessions.create",
              "sessions.compact",
              "sessions.list",
              "sessions.patch",
              "sessions.resolve",
              "sessions.send",
              "tools.catalog",
              "tools.effective",
              "tools.invoke",
            ],
            events: ["agent", "sessions.changed"],
          },
          snapshot: {
            presence: [],
            health: {},
            stateVersion: { presence: 0, health: 0 },
            uptimeMs: 1,
          },
          auth: { role: "operator", scopes: [] },
          policy: {
            maxPayload: 262144,
            maxBufferedBytes: 262144,
            tickIntervalMs: 30000,
          },
        });
        return;
      }

      if (frame.method === "agent") {
        const params = frame.params as { sessionKey?: string } | undefined;
        reply({
          status: "accepted",
          runId: "run-sdk-e2e",
          sessionKey: params?.sessionKey,
        });
        setTimeout(() => {
          for (const [stream, data] of [
            ["lifecycle", { phase: "start" }],
            ["assistant", { delta: "hello from fake gateway" }],
            ["lifecycle", { phase: "end" }],
          ] as const) {
            sendJson(socket, {
              type: "event",
              event: "agent",
              seq: seq++,
              payload: {
                runId: "run-sdk-e2e",
                sessionKey: params?.sessionKey,
                stream,
                ts: Date.now(),
                data,
              },
            });
          }
        }, 50);
        return;
      }

      const params = frame.params as JsonObject | undefined;
      const echo = { ok: true, method: frame.method, params };
      const responses: Record<string, JsonObject> = {
        "agents.list": { agents: [{ id: "main" }] },
        "agent.identity.get": { agentId: "main", ...params },
        "agents.create": echo,
        "agents.update": echo,
        "agents.delete": echo,
        "agent.wait": {
          status: "ok",
          runId: "run-sdk-e2e",
          sessionKey: "main",
          startedAt: 123,
          endedAt: 456,
        },
        "sessions.list": { sessions: [{ key: "sdk-session" }] },
        "sessions.create": { key: params?.key ?? "sdk-session" },
        "sessions.resolve": { key: "sdk-session", params },
        "sessions.send": { status: "ok", runId: "run-session-e2e", sessionKey: params?.key },
        "sessions.abort": {
          ok: true,
          abortedRunId: params?.runId ?? "run-sdk-e2e",
          status: "aborted",
        },
        "sessions.patch": echo,
        "sessions.compact": echo,
        "models.list": { models: [{ id: "gpt-5.4" }] },
        "models.authStatus": { providers: [] },
        "tools.catalog": { tools: [{ name: "shell" }] },
        "tools.effective": { tools: [{ name: "shell", enabled: true }] },
        "tools.invoke": { ok: true, toolName: "shell", output: { ok: true } },
        "exec.approval.list": { approvals: [] },
      };
      const response = Object.hasOwn(responses, frame.method) && responses[frame.method];
      if (response) {
        reply(response);
        return;
      }

      if (frame.method === "exec.approval.resolve") {
        expect(frame.params).toMatchObject({ id: "approval-1", decision: "allow-once" });
        reply({ ok: true, params: frame.params as JsonObject | undefined });
        return;
      }

      sendJson(socket, {
        type: "res",
        id: frame.id,
        ok: false,
        error: { code: "UNKNOWN_METHOD", message: `unhandled fake Gateway method ${frame.method}` },
      });
    });
  });

  const { port: boundPort } = server.address() as AddressInfo;
  return {
    url: `ws://127.0.0.1:${boundPort}`,
    requests,
    close: () => {
      const index = servers.indexOf(server);
      if (index >= 0) {
        servers.splice(index, 1);
      }
      for (const socket of server.clients) {
        socket.terminate();
      }
      return new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

describe("OpenClaw SDK websocket e2e", () => {
  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            for (const client of server.clients) {
              client.terminate();
            }
            server.close(() => resolve());
          }),
      ),
    );
  });

  it("runs an agent and streams normalized events over a Gateway websocket", async () => {
    const gateway = await createFakeGateway();
    const transport = new GatewayClientTransport({
      url: gateway.url,
      deviceIdentity: null,
      requestTimeoutMs: 2_000,
    });
    const oc = new OpenClaw({ transport });
    try {
      const agent = await oc.agents.get("main");
      const run = await agent.run({
        input: "say hello",
        sessionKey: "main",
        idempotencyKey: "sdk-e2e",
      });
      const seenPromise = (async () => {
        const seen: string[] = [];

        for await (const event of run.events()) {
          seen.push(event.type);
          if (event.type === "run.completed") {
            break;
          }
        }

        return seen;
      })();

      const [seen, result] = await Promise.all([
        withTimeout(seenPromise, 2_000, { message: "timed out waiting for SDK run events" }),
        run.wait({ timeoutMs: 2_000 }),
      ]);

      expect(run.id).toBe("run-sdk-e2e");
      expect(seen).toEqual(["run.started", "assistant.delta", "run.completed"]);
      expect(result).toMatchObject({
        runId: "run-sdk-e2e",
        sessionKey: "main",
        status: "completed",
        startedAt: 123,
        endedAt: 456,
      });
      const cancelResult = expectJsonObject(await run.cancel());
      expect(cancelResult).toMatchObject({ abortedRunId: "run-sdk-e2e", status: "aborted" });
    } finally {
      await oc.close();
      await gateway.close();
    }
  });

  it("covers documented namespace helpers over a Gateway websocket", async () => {
    const gateway = await createFakeGateway();
    const transport = new GatewayClientTransport({
      url: gateway.url,
      deviceIdentity: null,
      requestTimeoutMs: 2_000,
    });
    const oc = new OpenClaw({ transport });

    try {
      await expectResponse(oc.agents.list(), { agents: [{ id: "main" }] });
      const agent = await oc.agents.get("main");
      await expectResponse(agent.identity({ sessionKey: "sdk-session" }), {
        agentId: "main",
        sessionKey: "sdk-session",
      });
      await expectResponse(oc.agents.create({ name: "SDK Agent", workspace: "/tmp/sdk-agent" }), {
        method: "agents.create",
        params: { name: "SDK Agent", workspace: "/tmp/sdk-agent" },
      });
      await expectResponse(oc.agents.update({ agentId: "sdk-agent", name: "Renamed SDK Agent" }), {
        method: "agents.update",
        params: { agentId: "sdk-agent", name: "Renamed SDK Agent" },
      });
      await expectResponse(oc.agents.update({ agentId: "sdk-agent", model: null }), {
        params: { agentId: "sdk-agent", model: null },
      });
      await expectResponse(oc.agents.delete({ agentId: "sdk-agent" }), {
        method: "agents.delete",
        params: { agentId: "sdk-agent" },
      });

      await expectResponse(oc.sessions.list(), { sessions: [{ key: "sdk-session" }] });
      const session = await oc.sessions.create({ key: "sdk-session", agentId: "main" });
      expect(session.key).toBe("sdk-session");
      await expectResponse(oc.sessions.resolve({ key: "sdk-session" }), { key: "sdk-session" });
      const sessionRun = await session.send("continue");
      expect(sessionRun.id).toBe("run-session-e2e");
      await expectResponse(session.abort(sessionRun.id), { abortedRunId: "run-session-e2e" });
      await expectResponse(session.patch({ label: "Renamed" }), { method: "sessions.patch" });
      await expectResponse(session.compact({ maxLines: 200 }), { method: "sessions.compact" });

      await expectResponse(oc.models.list(), { models: [{ id: "gpt-5.4" }] });
      await expectResponse(oc.models.status({ probe: false }), { providers: [] });
      await expectResponse(oc.tools.list(), { tools: [{ name: "shell" }] });
      await expectResponse(oc.tools.effective({ sessionKey: "sdk-session" }), {
        tools: [{ name: "shell", enabled: true }],
      });
      await expectResponse(
        oc.tools.invoke("shell", { args: { command: "pwd" }, sessionKey: "sdk-session" }),
        { ok: true, toolName: "shell", output: { ok: true } },
      );
      await expectResponse(oc.approvals.list(), { approvals: [] });
      await expectResponse(oc.approvals.respond("approval-1", { decision: "allow-once" }), {
        ok: true,
      });

      expect(gateway.requests.map((request) => request.method)).toEqual([
        "connect",
        "agents.list",
        "agent.identity.get",
        "agents.create",
        "agents.update",
        "agents.update",
        "agents.delete",
        "sessions.list",
        "sessions.create",
        "sessions.resolve",
        "sessions.send",
        "sessions.abort",
        "sessions.patch",
        "sessions.compact",
        "models.list",
        "models.authStatus",
        "tools.catalog",
        "tools.effective",
        "tools.invoke",
        "exec.approval.list",
        "exec.approval.resolve",
      ]);
      const requestParams = new Map(
        gateway.requests.map((request) => [request.method, request.params]),
      );
      expect(requestParams.get("agents.list")).toEqual({});
      expect(requestParams.get("sessions.list")).toEqual({});
      expect(requestParams.get("models.list")).toEqual({});
      expect(requestParams.get("tools.catalog")).toEqual({});
      expect(requestParams.get("exec.approval.list")).toEqual({});
    } finally {
      await oc.close();
      await gateway.close();
    }
  }, 10_000);

  it("retries after an initial websocket connection failure", async () => {
    const port = await reservePort();
    const url = `ws://127.0.0.1:${port}`;
    const transport = new GatewayClientTransport({
      url,
      deviceIdentity: null,
      connectChallengeTimeoutMs: 200,
      preauthHandshakeTimeoutMs: 200,
      requestTimeoutMs: 500,
    });

    const initialConnectError = await transport.connect().catch((error: unknown) => error);
    expect(initialConnectError).toBeInstanceOf(Error);
    expect(String(initialConnectError)).toMatch(/ECONNREFUSED/);

    const gateway = await createFakeGateway(port);
    try {
      await expect(transport.connect()).resolves.toBeUndefined();
    } finally {
      await transport.close();
      await gateway.close();
    }
  });
});

describe("OpenClaw SDK real Gateway e2e", () => {
  installGatewayTestHooks({ scope: "test" });

  it("streams real Gateway agent events and preserves late replay order", async () => {
    const token = "sdk-real-gateway-token";
    const started = await startServer(token, { controlUiEnabled: false });
    const transport = new GatewayClientTransport({
      url: `ws://127.0.0.1:${started.port}`,
      token,
      deviceIdentity: null,
      requestTimeoutMs: 2_000,
    });
    const oc = new OpenClaw({ transport });
    const runId = "sdk-real-gateway-run";
    const replayRunId = "sdk-real-gateway-replay";

    try {
      await oc.connect();

      registerAgentRunContext(runId, {
        sessionKey: "agent:main:dashboard:sdk-real-gateway",
        verboseLevel: "off",
      });

      const run = await oc.runs.get(runId);
      const eventsPromise = (async () => {
        const seen: OpenClawEvent[] = [];
        for await (const event of run.events()) {
          seen.push(event);
          if (event.type === "run.completed") {
            break;
          }
        }
        return seen;
      })();

      emitAgentEvent({
        runId,
        stream: "lifecycle",
        data: { phase: "start", startedAt: 111 },
      });
      emitAgentEvent({
        runId,
        stream: "assistant",
        data: { delta: "hello from real gateway" },
      });
      emitAgentEvent({
        runId,
        stream: "lifecycle",
        data: { phase: "end", endedAt: 222 },
      });

      const seen = await withTimeout(eventsPromise, 2_000, {
        message: "timed out waiting for real Gateway SDK events",
      });
      expect(seen).toMatchObject([
        {
          type: "run.started",
          sessionKey: "agent:main:dashboard:sdk-real-gateway",
          data: { phase: "start" },
          raw: { event: "agent" },
        },
        {
          type: "assistant.delta",
          sessionKey: "agent:main:dashboard:sdk-real-gateway",
          data: { text: "hello from real gateway", delta: "hello from real gateway" },
          raw: { event: "agent" },
        },
        {
          type: "run.completed",
          sessionKey: "agent:main:dashboard:sdk-real-gateway",
          data: { phase: "end" },
          raw: { event: "agent" },
        },
      ]);

      registerAgentRunContext(replayRunId, {
        sessionKey: "agent:main:dashboard:sdk-real-gateway",
        verboseLevel: "off",
      });
      const observedReplay = (async () => {
        for await (const event of oc.events((eventLocal) => eventLocal.runId === replayRunId)) {
          if (expectJsonObject(event.raw?.payload).seq === 600) {
            return;
          }
        }
        throw new Error("Gateway stream ended before the replay tail arrived");
      })();
      emitAgentEvent({
        runId: replayRunId,
        stream: "lifecycle",
        data: { phase: "start", startedAt: 333 },
      });
      for (let seq = 2; seq <= 600; seq += 1) {
        emitAgentEvent({
          runId: replayRunId,
          stream: "plan",
          data: { phase: "update", steps: [], explanation: `step ${seq}` },
        });
      }
      await withTimeout(observedReplay, 2_000, {
        message: "timed out waiting for real Gateway replay setup",
      });

      const replayRun = await oc.runs.get(replayRunId);
      const replayed = (async () => {
        const sequences: unknown[] = [];
        for await (const event of replayRun.events()) {
          sequences.push(expectJsonObject(event.raw?.payload).seq);
          if (sequences.length === 1) {
            emitAgentEvent({
              runId: replayRunId,
              stream: "lifecycle",
              data: { phase: "end", endedAt: 444 },
            });
          }
          if (event.type === "run.completed") {
            return sequences;
          }
        }
        throw new Error("Gateway stream ended before the live completion arrived");
      })();
      await expect(
        withTimeout(replayed, 2_000, { message: "timed out draining real Gateway SDK replay" }),
      ).resolves.toEqual(Array.from({ length: 501 }, (_, index) => index + 101));
    } finally {
      clearAgentRunContext(runId);
      clearAgentRunContext(replayRunId);
      await oc.close();
      await started.server.close();
      started.envSnapshot.restore();
    }
  });
});

const liveGatewayUrl = process.env.OPENCLAW_SDK_LIVE_GATEWAY_URL;
const liveGatewayToken = process.env.OPENCLAW_SDK_LIVE_GATEWAY_TOKEN;
const liveGatewayDescribe = liveGatewayUrl && liveGatewayToken ? describe : describe.skip;

function readLiveTextDelta(data: unknown): string {
  if (!data || typeof data !== "object") {
    return "";
  }
  const record = data as Record<string, unknown>;
  for (const key of ["delta", "text", "content"]) {
    const value = record[key];
    if (typeof value === "string") {
      return value;
    }
  }
  return "";
}

function expectArrayProperty(value: unknown, property: string): void {
  expect(value && typeof value).toBe("object");
  const record = value as Record<string, unknown>;
  expect(Array.isArray(record[property])).toBe(true);
}

liveGatewayDescribe("OpenClaw SDK live Gateway e2e", () => {
  it("connects to a configured Gateway, streams a real run, and waits for completion", async () => {
    const oc = new OpenClaw({
      url: liveGatewayUrl,
      token: liveGatewayToken,
      requestTimeoutMs: 20_000,
    });

    try {
      await oc.connect();
      expectArrayProperty(await oc.agents.list(), "agents");
      expectArrayProperty(await oc.models.status({ probe: false }), "providers");

      const agent = await oc.agents.get(process.env.OPENCLAW_SDK_LIVE_AGENT_ID ?? "main");
      const run = await agent.run({
        input: "Reply with exactly: OPENCLAW_SDK_LIVE_OK",
        sessionKey: `sdk-live-e2e-${Date.now()}`,
        deliver: false,
        timeoutMs: 120_000,
        label: "SDK live E2E",
      });

      const eventsPromise = (async () => {
        const eventTypes: string[] = [];
        let text = "";
        for await (const event of run.events()) {
          eventTypes.push(event.type);
          if (event.type === "assistant.delta" || event.type === "assistant.message") {
            text += readLiveTextDelta(event.data);
          }
          if (
            event.type === "run.completed" ||
            event.type === "run.failed" ||
            event.type === "run.cancelled" ||
            event.type === "run.timed_out"
          ) {
            return { eventTypes, terminal: event.type, text };
          }
        }
        return { eventTypes, terminal: undefined, text };
      })();

      const result = await run.wait({ timeoutMs: 180_000 });
      const events = await withTimeout(eventsPromise, 5_000, {
        message: "timed out waiting for live SDK run events",
      });

      expect(result.status).toBe("completed");
      expect(events.terminal).toBe("run.completed");
      expect(events.eventTypes).toContain("run.started");
      expect(events.text).toContain("OPENCLAW_SDK_LIVE_OK");
    } finally {
      await oc.close();
    }
  }, 240_000);
});
