// Real isolated Gateway RPCs. Prepare synthetic state separately from measured CPU scopes.
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { deserialize } from "node:v8";
import type { Worker } from "node:worker_threads";
import { buildDeviceAuthPayloadV3 } from "../../packages/gateway-client/src/device-auth.ts";
import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/version.ts";
import { isRecord } from "../../packages/normalization-core/src/record-coerce.ts";
import {
  publicKeyRawBase64UrlFromEd25519Pem,
  signEd25519Payload,
} from "../../src/infra/ed25519-signature.ts";
import { BASE_GATEWAY_BENCH_CONFIG } from "../lib/gateway-bench-runtime.ts";
import { createGatewayWsClient } from "../lib/gateway-ws-client.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    root: { type: "string" },
    output: { type: "string" },
    prepare: { type: "boolean", default: false },
    port: { type: "string", default: "41510" },
    boards: { type: "string", default: "24" },
    cards: { type: "string", default: "50" },
    clients: { type: "string", default: "12" },
    waves: { type: "string", default: "80" },
    "interval-ms": { type: "string", default: "250" },
    "start-at": { type: "string" },
  },
});
assert(values.root, "--root must name an exclusively owned synthetic fixture directory");
assert(values.prepare || values.output, "--output is required for a measurement");
const integer = (raw: string, label: string, min = 1) =>
  parseStrictIntegerOption({ raw, label, min, fallback: min });
const root = path.resolve(values.root);
const port = integer(values.port, "--port", 40000);
assert(port <= 65535);
const boardCount = integer(values.boards, "--boards");
const cardsPerBoard = integer(values.cards, "--cards");
const clientCount = integer(values.clients, "--clients");
const waves = integer(values.waves, "--waves");
const intervalMs = integer(values["interval-ms"], "--interval-ms");
const fixturePath = path.join(root, "workboard-fixture.json");
const configPath = path.join(root, "openclaw.json");
type Fixture = { format: string; boardCount: number; cardsPerBoard: number; firstCards: string[] };
let fixture: Fixture;
if (values.prepare) {
  await mkdir(root);
  fixture = { format: "workboard-read-v1", boardCount, cardsPerBoard, firstCards: [] };
} else {
  fixture = JSON.parse(await readFile(fixturePath, "utf8"));
  assert.equal(fixture.format, "workboard-read-v1");
  assert.equal(fixture.boardCount, boardCount);
  assert.equal(fixture.cardsPerBoard, cardsPerBoard);
  assert.equal(fixture.firstCards.length, boardCount);
}
await mkdir(path.join(root, "tmp"), { recursive: true });
Object.assign(process.env, {
  HOME: root,
  OPENCLAW_HOME: root,
  OPENCLAW_STATE_DIR: path.join(root, "state"),
  OPENCLAW_CONFIG_PATH: configPath,
  OPENCLAW_SKIP_CHANNELS: "1",
  TMPDIR: path.join(root, "tmp"),
});
const config = {
  ...BASE_GATEWAY_BENCH_CONFIG,
  diagnostics: { enabled: true },
  agents: {
    defaults: { model: "synthetic/model", skipBootstrap: true },
    entries: { main: { workspace: path.join(root, "workspace") } },
  },
  memory: { search: { enabled: false } },
  cron: { enabled: false },
  plugins: { enabled: true, allow: ["workboard"], entries: { workboard: { enabled: true } } },
};
await writeFile(configPath, JSON.stringify(config));

const { startGatewayServer } = await import("../../src/gateway/server.ts");
const { onInternalDiagnosticEvent, waitForDiagnosticEventsDrained } =
  await import("../../src/infra/diagnostic-events.ts");
const methods = ["workboard.boards.list", "workboard.cards.list"] as const;
type Method = (typeof methods)[number];
type Samples = {
  roundTripMs: number[];
  handlerMs: number[];
  responseBytes: number;
  errors: number;
};
type Phase = {
  name: string;
  startedAtMs: number;
  scheduledAtMs: number;
  elapsedMs: number;
  cpuMs: number;
  methods: Record<Method, Samples>;
  workerRequests: Record<string, number>;
  workboardReads: Record<string, number>;
};
const phases: Phase[] = [];
let active: Phase | undefined;
let droppedDiagnostics = 0;
// Observe existing worker transport without adding a test seam to the persistence owner.
function observeWorker(worker: Worker) {
  const post = worker.postMessage.bind(worker);
  worker.postMessage = (...args: Parameters<Worker["postMessage"]>) => {
    const message = args[0];
    const body = isRecord(message) && message.type === "post" ? message.value : message;
    if (active && isRecord(body) && body.type === "execute" && body.input instanceof Uint8Array) {
      const input: unknown = deserialize(body.input);
      const command = isRecord(input) && isRecord(input.command) ? input.command : input;
      if (
        isRecord(command) &&
        (command.type === "cards.listBoardAggregates" || command.type === "boards.entries")
      ) {
        active.workboardReads[command.type] = (active.workboardReads[command.type] ?? 0) + 1;
      }
    }
    return post(...args);
  };
}
process.on("worker", observeWorker);
const unsubscribe = onInternalDiagnosticEvent((event) => {
  if (!active) {
    return;
  }
  if (event.type === "diagnostic.async_queue.dropped") {
    droppedDiagnostics += event.droppedEvents;
  } else if (event.type === "gateway.rpc" && event.phase === "handler") {
    const method = methods.find((candidate) => candidate === event.method);
    if (method) {
      active.methods[method].handlerMs.push(event.durationMs);
    }
  } else if (event.type === "worker.request" && event.phase === "started") {
    const key = `${event.kind}:${event.requestClass}`;
    active.workerRequests[key] = (active.workerRequests[key] ?? 0) + 1;
  }
});
const server = await startGatewayServer(port, { bind: "loopback", controlUiEnabled: false });
const peers: ReturnType<typeof createGatewayWsClient>[] = [];
async function rpc(peer: (typeof peers)[number], method: string, params: unknown) {
  const started = performance.now();
  const response = await peer.request(method, params, 60_000);
  const tracked = methods.find((candidate) => candidate === method);
  const sample = tracked ? active?.methods[tracked] : undefined;
  if (sample) {
    sample.roundTripMs.push(performance.now() - started);
    sample.responseBytes += Buffer.byteLength(JSON.stringify(response.payload ?? null));
    sample.errors += Number(!response.ok);
  }
  assert(response.ok, `${method}: ${JSON.stringify(response.error)}`);
  assert(isRecord(response.payload), `${method} returned no object`);
  return response.payload;
}
const boardId = (index: number) => `synthetic-board-${index}`;
const expectedReview = new Map<string, number>();
function checkBoards(payload: Record<string, unknown>) {
  assert(Array.isArray(payload.boards));
  assert.equal(payload.boards.length, boardCount + 1);
  let total = 0;
  for (const board of payload.boards) {
    assert(isRecord(board) && typeof board.total === "number");
    assert(typeof board.id === "string" && isRecord(board.byStatus));
    assert.equal(board.byStatus.review ?? 0, expectedReview.get(board.id) ?? 0);
    total += board.total;
  }
  assert.equal(total, boardCount * cardsPerBoard);
}
try {
  for (let index = 0; index < (values.prepare ? 1 : clientCount); index++) {
    const challenge = Promise.withResolvers<{ nonce: string; ts: number }>();
    const peer = createGatewayWsClient({
      url: `ws://127.0.0.1:${port}`,
      onEvent(event) {
        if (event.event === "connect.challenge" && isRecord(event.payload)) {
          const { nonce, ts } = event.payload;
          if (typeof nonce === "string" && typeof ts === "number") {
            challenge.resolve({ nonce, ts });
          }
        }
      },
    });
    peers.push(peer);
    await peer.waitOpen();
    const { nonce, ts } = await challenge.promise;
    const keys = generateKeyPairSync("ed25519");
    const publicKey = publicKeyRawBase64UrlFromEd25519Pem(
      keys.publicKey.export({ type: "spki", format: "pem" }),
    );
    const deviceId = createHash("sha256").update(Buffer.from(publicKey, "base64url")).digest("hex");
    const client = { id: "gateway-client", version: "dev", platform: "web", mode: "backend" };
    const scopes = ["operator.admin", "operator.read", "operator.write"];
    await rpc(peer, "connect", {
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      client,
      role: "operator",
      scopes,
      caps: [],
      device: {
        id: deviceId,
        publicKey,
        nonce,
        signedAt: ts,
        signature: signEd25519Payload(
          keys.privateKey.export({ type: "pkcs8", format: "pem" }),
          buildDeviceAuthPayloadV3({
            deviceId,
            clientId: client.id,
            clientMode: client.mode,
            platform: client.platform,
            role: "operator",
            scopes,
            signedAtMs: ts,
            nonce,
          }),
        ),
      },
    });
  }
  const controller = peers[0]!;
  if (values.prepare) {
    for (let board = 0; board < boardCount; board++) {
      await rpc(controller, "workboard.boards.upsert", {
        id: boardId(board),
        name: `Synthetic board ${board}`,
        kind: "cards",
      });
      for (let card = 0; card < cardsPerBoard; card++) {
        const created = await rpc(controller, "workboard.cards.create", {
          boardId: boardId(board),
          title: `Synthetic card ${board}/${card}`,
          status: "backlog",
          notes: "Synthetic dashboard workload. No external service or agent execution.",
          sourceUrl: `https://github.com/example/synthetic/pull/${board * cardsPerBoard + card + 1}`,
          labels: ["synthetic", `group-${card % 5}`],
        });
        assert(isRecord(created.card) && typeof created.card.id === "string");
        if (card === 0) {
          fixture.firstCards.push(created.card.id);
        }
      }
    }
    checkBoards(await rpc(controller, "workboard.boards.list", {}));
    await writeFile(fixturePath, JSON.stringify(fixture));
    console.log(JSON.stringify({ prepared: true, boardCount, cardsPerBoard }));
  } else {
    // Warm both endpoints for every board; separate cold startup from unchanged polling.
    for (let board = 0; board < boardCount; board++) {
      checkBoards(await rpc(controller, "workboard.cards.list", { boardId: boardId(board) }));
    }
    const measurementStart = values["start-at"]
      ? integer(values["start-at"], "--start-at")
      : Date.now() + 100;
    for (const name of ["warm", "after-mutation"]) {
      const scheduledAtMs = measurementStart + (name === "warm" ? 0 : waves * intervalMs + 5_000);
      const wait = scheduledAtMs - Date.now();
      assert(wait > 0, `Missed the paired ${name} start`);
      await delay(wait);
      const phase: Phase = {
        name,
        startedAtMs: Date.now(),
        scheduledAtMs,
        elapsedMs: 0,
        cpuMs: 0,
        workerRequests: {},
        workboardReads: {},
        methods: {
          "workboard.boards.list": {
            roundTripMs: [],
            handlerMs: [],
            responseBytes: 0,
            errors: 0,
          },
          "workboard.cards.list": {
            roundTripMs: [],
            handlerMs: [],
            responseBytes: 0,
            errors: 0,
          },
        },
      };
      active = phase;
      const started = performance.now();
      const cpu = process.cpuUsage();
      for (let wave = 0; wave < waves; wave++) {
        await delay(Math.max(0, started + wave * intervalMs - performance.now()));
        if (name === "after-mutation") {
          const board = wave % boardCount;
          await rpc(controller, "workboard.cards.update", {
            id: fixture.firstCards[board],
            patch: { status: Math.floor(wave / boardCount) % 2 === 0 ? "review" : "backlog" },
          });
          expectedReview.set(boardId(board), Math.floor(wave / boardCount) % 2 === 0 ? 1 : 0);
        }
        await Promise.all(
          peers.map(async (peer, index) => {
            const board = (wave + index) % boardCount;
            const [boards, cards] = await Promise.all([
              rpc(peer, "workboard.boards.list", {}),
              rpc(peer, "workboard.cards.list", { boardId: boardId(board) }),
            ]);
            checkBoards(boards);
            checkBoards(cards);
            assert(Array.isArray(cards.cards));
            assert.equal(cards.cards.length, Math.min(100, cardsPerBoard));
            for (const card of cards.cards) {
              assert(isRecord(card));
              assert.equal(
                card.status,
                card.id === fixture.firstCards[board] && expectedReview.get(boardId(board))
                  ? "review"
                  : "backlog",
              );
            }
          }),
        );
      }
      await waitForDiagnosticEventsDrained();
      phase.elapsedMs = performance.now() - started;
      const used = process.cpuUsage(cpu);
      phase.cpuMs = (used.user + used.system) / 1000;
      active = undefined;
      if (name === "after-mutation") {
        for (const command of ["boards.entries", "cards.listBoardAggregates"]) {
          assert(
            (phase.workboardReads[command] ?? 0) > 0,
            `Missing ${command} observations after writes`,
          );
        }
      }
      phases.push(phase);
    }
    assert.equal(droppedDiagnostics, 0, "Diagnostic loss makes handler counts incomplete");
    const stats = (samples: number[]) => {
      const sorted = samples.toSorted((a, b) => a - b);
      return {
        count: sorted.length,
        totalMs: sorted.reduce((sum, n) => sum + n, 0),
        p50Ms: sorted[Math.floor(sorted.length * 0.5)],
        p99Ms: sorted[Math.floor(sorted.length * 0.99)],
      };
    };
    const report = {
      boardCount,
      cardsPerBoard,
      clientCount,
      waves,
      intervalMs,
      phases: phases.map((phase) => ({
        name: phase.name,
        startedAtMs: phase.startedAtMs,
        scheduledAtMs: phase.scheduledAtMs,
        elapsedMs: phase.elapsedMs,
        cpuMs: phase.cpuMs,
        workerRequests: phase.workerRequests,
        workboardReads: phase.workboardReads,
        methods: Object.fromEntries(
          methods.map((method) => {
            const { roundTripMs, handlerMs, ...rest } = phase.methods[method];
            assert.equal(
              handlerMs.length,
              waves * clientCount,
              `Incomplete handler metrics for ${method}`,
            );
            return [
              method,
              {
                ...rest,
                roundTrip: stats(roundTripMs),
                handler: stats(handlerMs),
                handlerSecondsPer15Minutes: (stats(handlerMs).totalMs * 900) / phase.elapsedMs,
              },
            ];
          }),
        ),
      })),
    };
    await writeFile(values.output!, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify(report));
  }
} finally {
  active = undefined;
  for (const peer of peers) {
    peer.close();
  }
  unsubscribe();
  try {
    await server.close({ reason: "synthetic Workboard benchmark finished" });
  } finally {
    process.off("worker", observeWorker);
  }
}
