import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { WebSocket, WebSocketServer } from "ws";
import { rawDataToString } from "../../packages/gateway-client/src/websocket-data.js";
import { GATEWAY_CLIENT_CAPS } from "../../packages/gateway-protocol/src/client-info.js";
import { createGatewayBroadcaster } from "../../src/gateway/server-broadcast.js";
import { createSessionMessageSubscriberRegistry } from "../../src/gateway/server-chat-state.js";
import { GatewayClientRegistry } from "../../src/gateway/server/client-registry.js";
import type { GatewayWsClient } from "../../src/gateway/server/ws-types.js";

// Synthetic cumulative snapshots, replayed through the production delivery owner
// and real WebSockets. This measures raw JSON bytes, not compressed network bytes.
const { values } = parseArgs({
  options: {
    port: { type: "string", default: "41512" },
    clients: { type: "string", default: "43" },
    "full-clients": { type: "string", default: "3" },
    tools: { type: "string", default: "527" },
    event: { type: "string", default: "session.tool" },
    "expect-previews": { type: "boolean", default: false },
    "start-at": { type: "string" },
  },
});
function integer(raw: string, minimum: number) {
  const value = Number(raw);
  assert(Number.isSafeInteger(value) && value >= minimum, `invalid integer: ${raw}`);
  return value;
}
const port = integer(values.port, 40000);
assert(port <= 65535);
const clientCount = integer(values.clients, 1);
const fullClients = integer(values["full-clients"], 1);
assert(fullClients < clientCount);
const toolCount = integer(values.tools, 1);
assert(values.event === "session.tool" || values.event === "agent");
const sessionKey = "agent:main:synthetic-tool-frame-replay";
const heavyFields = ["args", "diff", "partialResult", "result"] as const;
type ToolData = {
  name: string;
  toolCallId: string;
  phase: string;
  args?: Record<string, string>;
  partialResult?: { content: { type: string; text: string }[] };
  result?: { content: { type: string; text: string }[] };
  diff?: string;
  isError?: boolean;
};
type Payload = {
  sessionKey: string;
  runId: string;
  seq: number;
  ts: number;
  stream: string;
  data: ToolData;
};
type Tally = { frames: number; bytes: number; fields: Record<string, number> };
const tally = (): Tally => ({ frames: 0, bytes: 0, fields: {} });
const byAudience = { narration: tally(), full: tally() };
const byTool: Record<string, Tally> = {};
const sourceFields: Record<string, number> = {};
const expected = new Map<number, Payload>();
const sourceHash = createHash("sha256");
const fullHash = createHash("sha256");
const clients = new GatewayClientRegistry();
const subscribers = createSessionMessageSubscriberRegistry();
const broadcaster = createGatewayBroadcaster({
  clients,
  sessionMessageSubscribers: subscribers,
  canReceiveSessionEvent: () => true,
});
const server = new WebSocketServer({ host: "127.0.0.1", port, perMessageDeflate: false });
await once(server, "listening");
const peers: WebSocket[] = [];
const received = Array.from({ length: clientCount }, () => 0);
let failure: Error | undefined;
let completeBatch: (() => void) | undefined;
let batchTarget = 0;
for (let index = 0; index < clientCount; index += 1) {
  const accepted = once(server, "connection");
  const peer = new WebSocket(`ws://127.0.0.1:${port}`, { perMessageDeflate: false });
  peers.push(peer);
  let receivedCount = 0;
  peer.on("message", (raw) => {
    try {
      const text = rawDataToString(raw);
      const frame = JSON.parse(text) as { event: string; seq: number; payload: Payload };
      assert.equal(frame.event, values.event);
      received[index] = ++receivedCount;
      assert.equal(frame.seq, receivedCount);
      const source = expected.get(frame.payload.seq);
      assert(source, "unexpected or late frame");
      const full = index < fullClients;
      const group = byAudience[full ? "full" : "narration"];
      const bytes = Buffer.byteLength(text);
      group.frames += 1;
      group.bytes += bytes;
      const kind = (byTool[toolCategory(Math.floor((frame.payload.seq - 1) / 6))] ??= tally());
      kind.frames += 1;
      kind.bytes += bytes;
      for (const field of heavyFields) {
        const value = frame.payload.data[field];
        if (value !== undefined) {
          const size = Buffer.byteLength(JSON.stringify({ [field]: value })) - 2;
          group.fields[field] = (group.fields[field] ?? 0) + size;
          kind.fields[field] = (kind.fields[field] ?? 0) + size;
        }
      }
      if (full || !values["expect-previews"]) {
        assert.deepEqual(frame.payload, source);
      } else {
        const {
          args: _args,
          diff: _diff,
          partialResult: _partial,
          result: _result,
          ...metadata
        } = source.data;
        assert.deepEqual(frame.payload, { ...source, data: metadata });
      }
      if (index === 0) {
        fullHash.update(JSON.stringify(frame.payload));
      }
      if (received.every((count) => count === batchTarget)) {
        completeBatch?.();
      }
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
      completeBatch?.();
    }
  });
  await once(peer, "open");
  const [socket] = (await accepted) as [WebSocket];
  const connId = `replay-${index}`;
  const client: GatewayWsClient = {
    connId,
    socket,
    usesSharedGatewayAuth: false,
    connect: {
      minProtocol: 3,
      maxProtocol: 3,
      client: { id: "openclaw-control-ui", version: "synthetic", platform: "node", mode: "ui" },
      role: "operator",
      scopes: ["operator.admin"],
      caps: [GATEWAY_CLIENT_CAPS.SESSION_SCOPED_EVENTS],
    },
  };
  clients.add(client);
  subscribers.subscribe(
    connId,
    sessionKey,
    index < fullClients ? undefined : { mode: "narration" },
  );
}
function toolCategory(tool: number) {
  return tool % 20 < 12 ? "shell_exec" : tool % 20 < 17 ? "code_mode_exec" : "read";
}
function fixture(tool: number, step: number): Payload {
  const category = toolCategory(tool);
  const name = category === "read" ? "read" : "exec";
  const args: Record<string, string> =
    category === "shell_exec"
      ? { command: `printf synthetic ${"x".repeat(256)}` }
      : category === "code_mode_exec"
        ? { code: `// synthetic code\n${"x".repeat(2048)}` }
        : { path: `/synthetic/fixture-${tool}.txt` };
  const data: ToolData = {
    name,
    toolCallId: `synthetic-call-${tool}`,
    phase: step === 0 ? "start" : step === 5 ? "result" : "update",
    ...(step === 0 ? { args } : {}),
  };
  if (step > 0) {
    const text = "synthetic output\n".repeat(512).slice(0, Math.min(step * 2048, 8000));
    const result = { content: [{ type: "text", text }] };
    if (step === 5) {
      data.result = result;
      data.isError = false;
    } else {
      data.partialResult = result;
    }
  }
  return {
    sessionKey,
    runId: `synthetic-run-${Math.floor(tool / 10)}`,
    seq: tool * 6 + step + 1,
    ts: 1_700_000_000_000 + tool * 6 + step,
    stream: "tool",
    data,
  };
}
if (values["start-at"]) {
  await delay(Math.max(0, integer(values["start-at"], 1) - Date.now()));
}
const started = performance.now();
const cpuStart = process.cpuUsage();
const batchMs: number[] = [];
try {
  for (let tool = 0; tool < toolCount; tool += 1) {
    expected.clear();
    const payloads = Array.from({ length: 6 }, (_, step) => fixture(tool, step));
    for (const payload of payloads) {
      expected.set(payload.seq, payload);
      sourceHash.update(JSON.stringify(payload));
      for (const field of heavyFields) {
        if (payload.data[field] !== undefined) {
          sourceFields[field] =
            (sourceFields[field] ?? 0) +
            Buffer.byteLength(JSON.stringify({ [field]: payload.data[field] })) -
            2;
        }
      }
    }
    batchTarget += payloads.length;
    const batchStarted = performance.now();
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("frame delivery timed out")), 30_000);
      completeBatch = () => {
        clearTimeout(timeout);
        resolve();
      };
      for (const payload of payloads) {
        broadcaster.broadcast(values.event, payload, { sessionKeys: [sessionKey] });
      }
    });
    if (failure) {
      throw failure;
    }
    batchMs.push(performance.now() - batchStarted);
  }
  const elapsedMs = performance.now() - started;
  const cpu = process.cpuUsage(cpuStart);
  assert.equal(fullHash.digest("hex"), sourceHash.digest("hex"));
  batchMs.sort((a, b) => a - b);
  console.log(
    JSON.stringify({
      workload: { clients: clientCount, fullClients, tools: toolCount, event: values.event },
      expectedPreviews: values["expect-previews"],
      elapsedMs,
      cpuMs: (cpu.user + cpu.system) / 1000,
      batchMs: {
        median: batchMs[Math.floor(batchMs.length / 2)],
        p95: batchMs[Math.floor(batchMs.length * 0.95)],
      },
      sourceFields,
      byAudience,
      byTool,
      fullPayloadsIdentical: true,
    }),
  );
} finally {
  for (const peer of peers) {
    peer.terminate();
  }
  for (const client of clients) {
    client.socket.terminate();
  }
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}
