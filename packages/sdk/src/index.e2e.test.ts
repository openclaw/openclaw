import type { AddressInfo } from "node:net";
import net from "node:net";
import { describe, expect, it, vi } from "vitest";
import { claimAgentSessionWriter } from "../../../src/agents/embedded-agent-runner/run/session-bootstrap.js";
import * as embeddedRuns from "../../../src/agents/embedded-agent-runner/runs.test-support.js";
import { resolveDefaultSessionStorePath } from "../../../src/config/sessions/paths.js";
import * as sessions from "../../../src/config/sessions/session-accessor.js";
import type { InternalSessionEntry } from "../../../src/config/sessions/types.js";
import { installGatewayTestHooks, startServer } from "../../../src/gateway/test-helpers.js";
import {
  emitAgentEvent,
  getAgentEventLifecycleGeneration,
} from "../../../src/infra/agent-events.js";
import * as runContexts from "../../../src/infra/agent-run-registry.js";
import {
  clearAgentRunContext,
  registerAgentRunContext,
} from "../../../src/infra/agent-run-registry.js";
import { withTimeout } from "../../../src/infra/fs-safe.js";
import { collectUntil } from "./client.test-support.js";
import { GatewayClientTransport, OpenClaw, type OpenClawEvent } from "./index.js";
import { createSdkWebSocketServer } from "./transport.websocket.test-support.js";

type JsonObject = Record<string, unknown>;
type Request = <T>(
  method: string,
  params: unknown,
  response: unknown,
  invoke: () => Promise<T>,
) => Promise<T>;

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

async function withGateway(body: (oc: OpenClaw, request: Request) => Promise<void>) {
  const gateway = await createSdkWebSocketServer();
  const oc = createClient(gateway.url);
  const request: Request = async (method, params, response, invoke) => {
    let calls = 0;
    gateway.setRequestHandler((socket, frame) => {
      calls++;
      expect([frame.method, frame.params]).toEqual([method, params]);
      gateway.reply(socket, frame.id, response);
    });
    const result = await invoke();
    expect(calls).toBe(1);
    return result;
  };
  try {
    await body(oc, request);
  } finally {
    await oc.close();
    await gateway.close();
  }
}

function expectJsonObject(value: unknown): JsonObject {
  expect(value && typeof value).toBe("object");
  return value as JsonObject;
}

const collectRun = (events: AsyncIterable<OpenClawEvent>) =>
  collectUntil(events, (event) => event.type === "run.completed");

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

describe("OpenClaw SDK websocket e2e", () => {
  it("covers documented namespace helpers over a Gateway websocket", async () => {
    await withGateway(async (oc, request) => {
      const rpc = async (
        method: string,
        params: unknown,
        response: unknown,
        invoke: () => Promise<unknown>,
      ) => expect(request(method, params, response, invoke)).resolves.toEqual(response);
      const echo = <T>(method: string, params: T, invoke: (params: T) => Promise<unknown>) =>
        rpc(method, params, { ok: true, method, params }, () => invoke(structuredClone(params)));

      for (const [method, invoke, response] of [
        ["agents.list", () => oc.agents.list(), { agents: [{ id: "main" }] }],
        ["sessions.list", () => oc.sessions.list(), { sessions: [{ key: "sdk-session" }] }],
        ["models.list", () => oc.models.list(), { models: [{ id: "gpt-5.4" }] }],
        ["tools.catalog", () => oc.tools.list(), { tools: [{ name: "shell" }] }],
        ["exec.approval.list", () => oc.approvals.list(), { approvals: [] }],
      ] as const) {
        await rpc(method, {}, response, invoke);
      }
      const agent = await oc.agents.get("main");
      await rpc(
        "agent.identity.get",
        { agentId: "main", sessionKey: "sdk-session" },
        { agentId: "main", sessionKey: "sdk-session" },
        () => agent.identity({ sessionKey: "sdk-session" }),
      );
      await echo("agents.create", { name: "SDK Agent", workspace: "/tmp/sdk-agent" }, (p) =>
        oc.agents.create(p),
      );
      await echo("agents.update", { agentId: "sdk-agent", name: "Renamed SDK Agent" }, (p) =>
        oc.agents.update(p),
      );
      await echo("agents.update", { agentId: "sdk-agent", model: null }, (p) =>
        oc.agents.update(p),
      );
      await echo("agents.delete", { agentId: "sdk-agent" }, (p) => oc.agents.delete(p));

      const session = await request(
        "sessions.create",
        { key: "sdk-session", agentId: "main" },
        { key: "sdk-session" },
        () => oc.sessions.create({ key: "sdk-session", agentId: "main" }),
      );
      expect(session.key).toBe("sdk-session");
      await rpc(
        "sessions.resolve",
        { key: "sdk-session" },
        { key: "sdk-session", params: { key: "sdk-session" } },
        () => oc.sessions.resolve({ key: "sdk-session" }),
      );
      const run = await request(
        "sessions.send",
        { key: "sdk-session", message: "continue" },
        { status: "ok", runId: "run-session-e2e", sessionKey: "sdk-session" },
        () => session.send("continue"),
      );
      expect(run.id).toBe("run-session-e2e");
      await rpc(
        "sessions.abort",
        { key: session.key, runId: run.id },
        { ok: true, abortedRunId: run.id, status: "aborted" },
        () => session.abort(run.id),
      );
      await echo("sessions.patch", { label: "Renamed", key: session.key }, (p) =>
        session.patch({ label: p.label }),
      );
      await echo("sessions.compact", { maxLines: 200, key: session.key }, (p) =>
        session.compact({ maxLines: p.maxLines }),
      );
      await rpc("models.authStatus", { probe: false }, { providers: [] }, () =>
        oc.models.status({ probe: false }),
      );
      await rpc(
        "tools.effective",
        { sessionKey: session.key },
        { tools: [{ name: "shell", enabled: true }] },
        () => oc.tools.effective({ sessionKey: session.key }),
      );
      const toolParams = { args: { command: "pwd" }, sessionKey: session.key };
      await rpc(
        "tools.invoke",
        { name: "shell", conversationReadOrigin: "direct-operator", ...toolParams },
        { ok: true, toolName: "shell", output: { ok: true } },
        () => oc.tools.invoke("shell", toolParams),
      );
      const staleDecision = { id: "stale-approval", decision: "allow-once" as const };
      await rpc(
        "exec.approval.resolve",
        { id: "approval-1", decision: "allow-once" },
        { ok: true },
        () => oc.approvals.respond("approval-1", staleDecision),
      );
    });
  }, 10_000);

  it("retries after an initial websocket connection failure", async () => {
    const port = await reservePort();
    const transport = new GatewayClientTransport({
      url: `ws://127.0.0.1:${port}`,
      deviceIdentity: null,
      connectChallengeTimeoutMs: 200,
      preauthHandshakeTimeoutMs: 200,
      requestTimeoutMs: 500,
    });
    const initialConnectError = await transport.connect().catch((error: unknown) => error);
    expect(initialConnectError).toBeInstanceOf(Error);
    expect(String(initialConnectError)).toMatch(/ECONNREFUSED/);
    const gateway = await createSdkWebSocketServer(port);
    try {
      await expect(transport.connect()).resolves.toBeUndefined();
    } finally {
      await transport.close();
      await gateway.close();
    }
  });
});

async function withRealClient(body: (oc: OpenClaw) => Promise<void>) {
  const token = "sdk-real-gateway-token";
  const started = await startServer(token, { controlUiEnabled: false });
  const oc = createClient(`ws://127.0.0.1:${started.port}`, token);
  try {
    await body(oc);
  } finally {
    await oc.close();
    await started.server.close();
    started.envSnapshot.restore();
  }
}

describe("OpenClaw SDK real Gateway e2e", () => {
  installGatewayTestHooks({ scope: "test" });

  it("streams real Gateway agent events and preserves late replay order", async () => {
    await withRealClient(async (oc) => {
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
      }
    });
  });
  const terminalTypes = new Set(["run.completed", "run.failed", "run.cancelled", "run.timed_out"]);
  it("reports the superseded writer as cancelled in events and waits", async () => {
    await withRealClient(async (oc) => {
      const sessionId = "sdk-writer-session";
      const sessionKey = "agent:main:dashboard:sdk-writer-takeover";
      const runId = "sdk-prior-writer";
      const nextId = "sdk-next-writer";
      const storePath = resolveDefaultSessionStorePath("main");
      const target = { agentId: "main", sessionKey, storePath };
      const cancellation = vi.fn(() => sessions.loadSessionEntry(target));
      const incumbent = {
        ...embeddedRuns.createEmbeddedRunHandle({ runId, abort: vi.fn() }),
        kind: "embedded" as const,
        cancel: cancellation,
      };

      try {
        await oc.connect();
        await sessions.replaceSessionEntry(target, {
          sessionId,
          updatedAt: 1,
          lifecycleRevision: "sdk-writer-revision",
          activeWriterRunId: runId,
        } satisfies InternalSessionEntry);
        embeddedRuns.registerTestEmbeddedRun(sessionId, incumbent, sessionKey, sessionKey);
        runContexts.registerAgentRunContext(runId, {
          agentId: "main",
          lifecycleGeneration: getAgentEventLifecycleGeneration(),
          sessionId,
          sessionKey,
        });
        const run = await oc.runs.get(runId);
        const terminalEvent = (async () => {
          for await (const { type } of run.events((event) => terminalTypes.has(event.type))) {
            return type;
          }
          return undefined;
        })().catch((error: unknown) => error);

        await claimAgentSessionWriter({
          agentId: "main",
          prompt: "next turn",
          runId: nextId,
          sessionId,
          sessionKey,
          sessionTarget: { ...target, sessionId },
          timeoutMs: 30_000,
          workspaceDir: process.cwd(),
        });
        const [eventType, wait] = await Promise.all([
          withTimeout(terminalEvent, 2_000, { message: "missing superseded writer SDK event" }),
          run.wait({ timeoutMs: 500 }),
        ]);

        expect(cancellation).toHaveBeenCalledWith("superseded");
        expect(cancellation).toHaveReturnedWith(
          expect.objectContaining({ activeWriterRunId: nextId }),
        );
        expect(sessions.loadSessionEntry(target)).toMatchObject({ activeWriterRunId: nextId });
        expect([eventType, wait.status]).toEqual(["run.cancelled", "cancelled"]);
      } finally {
        embeddedRuns.clearTestEmbeddedRun(sessionId, incumbent, sessionKey, sessionKey);
        runContexts.clearAgentRunContext(runId);
      }
    });
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
