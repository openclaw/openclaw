import type { AddressInfo } from "node:net";
import net from "node:net";
import { rawDataToString } from "@openclaw/gateway-client/websocket-data";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
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

const gateways = new Set<FakeGateway>();

function createClient(url: string, token?: string) {
  return new OpenClaw({
    transport: new GatewayClientTransport({
      url,
      token,
      deviceIdentity: null,
      requestTimeoutMs: 2_000,
    }),
  });
}

async function withGateway(body: (oc: OpenClaw, gateway: FakeGateway) => Promise<void>) {
  const gateway = await createFakeGateway();
  const oc = createClient(gateway.url);
  try {
    await body(oc, gateway);
  } finally {
    await oc.close();
    await gateway.close();
  }
}

function expectJsonObject(value: unknown): JsonObject {
  expect(value && typeof value).toBe("object");
  return value as JsonObject;
}

async function expectResponse(response: Promise<unknown>, fields: JsonObject) {
  expect(expectJsonObject(await response)).toEqual(expect.objectContaining(fields));
}

async function collectRun(events: AsyncIterable<OpenClawEvent>) {
  const seen: OpenClawEvent[] = [];
  for await (const event of events) {
    seen.push(event);
    if (event.type === "run.completed") {
      break;
    }
  }
  return seen;
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
  await new Promise<void>((resolve) => {
    server.once("listening", resolve);
  });
  let seq = 1;
  const requests: FakeGatewayRequest[] = [];
  server.on("connection", (socket) => {
    const send = (frame: JsonObject) => socket.send(JSON.stringify(frame));
    send({
      type: "event",
      event: "connect.challenge",
      seq: seq++,
      payload: { nonce: "sdk-e2e-nonce", ts: Date.now() },
    });
    socket.on("message", (raw) => {
      const frame = JSON.parse(rawDataToString(raw)) as FakeGatewayRequest;
      requests.push(frame);
      const reply = (payload: JsonObject): void => {
        send({ type: "res", id: frame.id, ok: true, payload });
      };
      if (frame.method === "connect") {
        reply({
          type: "hello-ok",
          protocol: 1,
          policy: { tickIntervalMs: 30000 },
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
            send({
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

      send({
        type: "res",
        id: frame.id,
        ok: false,
        error: {
          code: "UNKNOWN_METHOD",
          message: `unhandled fake Gateway method ${frame.method}`,
        },
      });
    });
  });
  const gateway: FakeGateway = {
    url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    close: async () => {
      gateways.delete(gateway);
      for (const socket of server.clients) {
        socket.terminate();
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
  gateways.add(gateway);
  return gateway;
}

describe("OpenClaw SDK websocket e2e", () => {
  afterEach(() => Promise.all([...gateways].map((gateway) => gateway.close())));

  it("runs an agent and streams normalized events over a Gateway websocket", async () => {
    await withGateway(async (oc) => {
      const agent = await oc.agents.get("main");
      const run = await agent.run({
        input: "say hello",
        sessionKey: "main",
        idempotencyKey: "sdk-e2e",
      });
      const seenPromise = collectRun(run.events());
      const [seen, result] = await Promise.all([
        withTimeout(seenPromise, 2_000, { message: "timed out waiting for SDK run events" }),
        run.wait({ timeoutMs: 2_000 }),
      ]);
      expect(run.id).toBe("run-sdk-e2e");
      expect(seen.map((event) => event.type)).toEqual([
        "run.started",
        "assistant.delta",
        "run.completed",
      ]);
      expect(result).toMatchObject({
        runId: "run-sdk-e2e",
        sessionKey: "main",
        status: "completed",
        startedAt: 123,
        endedAt: 456,
      });
      const cancelResult = expectJsonObject(await run.cancel());
      expect(cancelResult).toMatchObject({ abortedRunId: "run-sdk-e2e", status: "aborted" });
    });
  });

  it("covers documented namespace helpers over a Gateway websocket", async () => {
    await withGateway(async (oc, gateway) => {
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
      for (const method of [
        "agents.list",
        "sessions.list",
        "models.list",
        "tools.catalog",
        "exec.approval.list",
      ]) {
        expect(requestParams.get(method)).toEqual({});
      }
    });
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
    const oc = createClient(`ws://127.0.0.1:${started.port}`, token);
    const runId = "sdk-real-gateway-run";
    const replayRunId = "sdk-real-gateway-replay";
    const sessionKey = "agent:main:dashboard:sdk-real-gateway";
    const registerRun = (id: string) =>
      registerAgentRunContext(id, { sessionKey, verboseLevel: "off" });

    try {
      await oc.connect();
      registerRun(runId);
      const run = await oc.runs.get(runId);
      const eventsPromise = collectRun(run.events());
      for (const [stream, data] of [
        ["lifecycle", { phase: "start", startedAt: 111 }],
        ["assistant", { delta: "hello from real gateway" }],
        ["lifecycle", { phase: "end", endedAt: 222 }],
      ] as const) {
        emitAgentEvent({ runId, stream, data });
      }

      const seen = await withTimeout(eventsPromise, 2_000, {
        message: "timed out waiting for real Gateway SDK events",
      });
      expect(seen).toMatchObject(
        (
          [
            ["run.started", { phase: "start" }],
            [
              "assistant.delta",
              { text: "hello from real gateway", delta: "hello from real gateway" },
            ],
            ["run.completed", { phase: "end" }],
          ] as const
        ).map(([type, data]) => ({
          type,
          data,
          sessionKey,
          raw: { event: "agent" },
        })),
      );

      registerRun(replayRunId);
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
  expect(Array.isArray(expectJsonObject(value)[property])).toBe(true);
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
            ["run.completed", "run.failed", "run.cancelled", "run.timed_out"].includes(event.type)
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
