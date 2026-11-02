// Synthetic owner retention, not Gateway traffic or provider latency.
// Run with node --import ./scripts/tsx.mjs; no operator state or external services.
import assert from "node:assert/strict";
import childProcess, { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough } from "node:stream";
import { mock } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { parseArgs } from "node:util";
import { queryObjects, writeHeapSnapshot } from "node:v8";
import { WebSocketServer } from "ws";
import { createRealtimeTranscriptionWebSocketSession } from "../../src/realtime-transcription/websocket-session.js";
import { createRealtimeVoiceAudioQueue } from "../../src/talk/realtime-session-lifecycle.js";

const { values } = parseArgs({
  options: {
    site: { type: "string" },
    snapshot: { type: "string" },
    port: { type: "string", default: "49693" },
  },
});
const workloads = { voice: [320, 960], meeting: [200, 4096], transcription: [1024, 960] } as const;
assert(
  values.site && Object.hasOwn(workloads, values.site),
  "--site voice|meeting|transcription required",
);
const site = values.site as keyof typeof workloads;
const [count, size] = workloads[site];
const port = Number(values.port);
assert(Number.isInteger(port) && port >= 40000 && port <= 65535, "--port must be 40000..65535");
const expected = Buffer.alloc(size, 7);
let enqueue: (audio: Buffer) => unknown;
let release: () => Promise<void>;

if (site === "voice") {
  const queue = createRealtimeVoiceAudioQueue("reject-newest");
  enqueue = (audio) => assert(queue.enqueue(audio));
  release = async () => {
    const chunks = queue.drain();
    assert.equal(chunks.length, count);
    for (const audio of chunks) {
      assert.deepEqual(audio, expected);
    }
  };
} else if (site === "transcription") {
  const server = new WebSocketServer({ host: "127.0.0.1", port });
  await once(server, "listening");
  let delivered = 0;
  const session = createRealtimeTranscriptionWebSocketSession({
    providerId: "synthetic",
    callbacks: {},
    url: `ws://127.0.0.1:${port}`,
    readyOnOpen: true,
    sendAudio: (audio) => {
      assert.deepEqual(audio, expected);
      delivered++;
    },
  });
  enqueue = (audio) => session.sendAudio(audio);
  release = async () => {
    try {
      await session.connect();
      assert.equal(delivered, count);
    } finally {
      session.close();
      for (const socket of server.clients) {
        socket.terminate();
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  };
} else {
  const stdout = new PassThrough();
  const createProcess = (input: boolean) => {
    const child = new ChildProcess();
    child.stdout = input ? stdout : null;
    child.stderr = new PassThrough();
    child.stdin = input ? null : new PassThrough();
    child.kill = () => {
      queueMicrotask(() => {
        stdout.emit("end");
        stdout.emit("close");
        child.emit("exit", 0);
        child.emit("close", 0);
      });
      return true;
    };
    return child;
  };
  // Exercise the actual capture callback and public pull/stop commands with synthetic I/O.
  let spawns = 0;
  const spawn = mock.method(childProcess, "spawn", () => createProcess(++spawns === 2));
  syncBuiltinESMExports();
  const { createMeetingNodeHost } = await import("../../src/meeting-bot/node-host.js");
  const host = createMeetingNodeHost({
    agentMode: "agent",
    assertAudioAvailable: () => {},
    bridgeIdPrefix: "synthetic-",
    browser: {
      application: "unused",
      buildProfileArgs: () => [],
      openedNotes: [],
      openedStatus: "opened",
    },
    browserLabel: "synthetic",
    commandName: "synthetic",
    defaultAudioInputCommand: ["capture"],
    defaultAudioOutputCommand: ["play"],
    displayName: "synthetic",
    normalizeMeetingKey: (url) => url,
    normalizeUrl: () => "https://example.invalid",
    talkBackModes: new Set(["bidi"]),
  });
  let bridgeId: string;
  try {
    const started = JSON.parse(
      await host.handleCommand(
        JSON.stringify({
          action: "start",
          launch: false,
          mode: "bidi",
          audioInputCommand: ["capture"],
          audioOutputCommand: ["play"],
        }),
      ),
    );
    bridgeId = started.bridgeId;
  } finally {
    spawn.mock.restore();
    syncBuiltinESMExports();
  }
  enqueue = (audio) => stdout.emit("data", audio);
  release = async () => {
    try {
      for (let i = 0; i < count; i++) {
        const result = JSON.parse(
          await host.handleCommand(JSON.stringify({ action: "pullAudio", bridgeId })),
        );
        assert.deepEqual(Buffer.from(result.base64, "base64"), expected);
      }
    } finally {
      await host.handleCommand(JSON.stringify({ action: "stop", bridgeId }));
    }
  };
}

const churn = "x".repeat(Buffer.poolSize / 2 - 8);
function movePool() {
  Buffer.from(churn);
  Buffer.from(churn);
  Buffer.from(churn);
}
function markFrame() {
  movePool();
  const before = Buffer.from("marker");
  const source = Buffer.alloc(size, 7);
  enqueue(source);
  source.fill(0);
  const after = Buffer.from("marker");
  return [new WeakRef(before.buffer), new WeakRef(after.buffer)];
}
const references = Array.from({ length: count }, markFrame).flat();
movePool();
const control = new WeakRef({});
await nextTurn();
queryObjects(WeakRef);
assert.equal(control.deref(), undefined, "GC control stayed alive");
const stores = new Set(references.map((ref) => ref.deref()).filter((store) => store !== undefined));
const retainedPoolBytes = [...stores].reduce((sum, store) => sum + store.byteLength, 0);
console.log(
  JSON.stringify({
    site,
    count,
    chunkBytes: size,
    logicalBytes: count * size,
    poolSize: Buffer.poolSize,
    retainedPoolStores: stores.size,
    retainedPoolBytes,
    retainedPoolMiB: retainedPoolBytes / 1024 ** 2,
    node: process.version,
  }),
);
if (values.snapshot) {
  writeHeapSnapshot(values.snapshot);
}
await release();
stores.clear();
await nextTurn();
queryObjects(WeakRef);
const retainedMarkersAfterRelease = references.filter((ref) => ref.deref() !== undefined).length;
console.log(JSON.stringify({ site, retainedMarkersAfterRelease }));
assert.equal(retainedMarkersAfterRelease, 0);
