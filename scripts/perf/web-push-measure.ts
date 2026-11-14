/**
 * Web Push owner benchmark; synthetic identities and a loopback HTTPS push sink only.
 * Run on each revision with Node 26:
 * node --import ./scripts/tsx.mjs scripts/perf/web-push-measure.ts --mode prepare --fanout 16
 * Modes: prepare (request crypto, no network), allocation (separate sampled-allocation pass),
 * https (real local HTTPS sends). Use five interleaved revision pairs, --iterations 2000
 * for preparation/allocation and --iterations 1600 for HTTPS (100 batches of 16).
 * Reports caller-blocked time separately from delivery latency; no Gateway-wide claims.
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import https from "node:https";
import { Session } from "node:inspector/promises";
import os from "node:os";
import path from "node:path";
import { PerformanceObserver, performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import webPush from "web-push";
import { prepareWebPushNotificationSender } from "../../src/infra/push-web.js";
import { TEST_TLS_CERT_PEM, TEST_TLS_KEY_PEM } from "../../test/helpers/tls-fixture.js";

const { values } = parseArgs({
  options: {
    mode: { type: "string", default: "prepare" },
    fanout: { type: "string", default: "16" },
    iterations: { type: "string", default: "2000" },
  },
});
const fanout = Number(values.fanout);
const iterations = Number(values.iterations);
if (
  !["prepare", "allocation", "https"].includes(values.mode) ||
  ![1, 4, 16].includes(fanout) ||
  !Number.isSafeInteger(iterations) ||
  iterations < fanout
) {
  throw new Error(
    "Use --mode prepare|allocation|https --fanout 1|4|16 --iterations <positive count>",
  );
}
const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "web-push-measure-"));
const identity = webPush.generateVAPIDKeys();
process.env.OPENCLAW_VAPID_PUBLIC_KEY = identity.publicKey;
process.env.OPENCLAW_VAPID_PRIVATE_KEY = identity.privateKey;
process.env.OPENCLAW_VAPID_SUBJECT = "mailto:synthetic@example.com";
const originalSend = webPush.sendNotification;
const originalAgent = https.globalAgent;
let received = 0;
const server = https.createServer(
  { key: TEST_TLS_KEY_PEM, cert: TEST_TLS_CERT_PEM },
  (request, response) => {
    request.resume();
    request.on("end", () => {
      received++;
      response.writeHead(201);
      response.end();
    });
  },
);
const inspector = new Session();
const gc: number[] = [];
const observer = new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    gc.push(entry.duration);
  }
});
try {
  let port = 41071;
  if (values.mode === "https") {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Missing HTTPS listener address");
    }
    port = address.port;
    // This agent is used only by this process's synthetic loopback requests.
    https.globalAgent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });
  } else {
    webPush.sendNotification = async (subscription, payload, options) => {
      if (typeof payload !== "string") {
        throw new Error("Expected notification JSON");
      }
      webPush.generateRequestDetails(subscription, payload, options);
      return { statusCode: 201, body: "", headers: {} };
    };
  }
  const subscriptions = Array.from({ length: fanout }, (_, index) => {
    const receiver = crypto.createECDH("prime256v1");
    receiver.generateKeys();
    return {
      subscriptionId: `synthetic-${index}`,
      endpoint: `https://127.0.0.1:${port}/push/${index}`,
      keys: {
        p256dh: receiver.getPublicKey().toString("base64url"),
        auth: crypto.randomBytes(16).toString("base64url"),
      },
      createdAtMs: 0,
      updatedAtMs: 0,
    };
  });
  const send = await prepareWebPushNotificationSender(stateDir);
  const params = {
    subscriptions,
    payload: {
      title: "Approval required",
      body: "An agent needs your approval to continue.",
      tag: "approval:synthetic",
      url: "/approve/synthetic",
      icon: `data:image/png;base64,${"a".repeat(600)}`,
    },
    deliveryOptions: { TTL: 60, urgency: "high" as const, timeout: 10_000 },
  };
  for (let i = 0; i < 100 / fanout; i++) {
    await send(params);
  }
  if (values.mode === "allocation") {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  observer.observe({ entryTypes: ["gc"] });
  const blocked: number[] = [];
  const latency: number[] = [];
  const before = process.threadCpuUsage();
  const started = performance.now();
  for (let i = 0; i < Math.ceil(iterations / fanout); i++) {
    const start = performance.now();
    const pending = send(params);
    blocked.push(performance.now() - start);
    const results = await pending;
    if (results.some((result) => !result.ok)) {
      throw new Error("Push delivery failed");
    }
    latency.push(performance.now() - start);
  }
  const wallMs = performance.now() - started;
  const cpu = process.threadCpuUsage(before);
  let allocatedBytes: number | null = null;
  if (values.mode === "allocation") {
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    allocatedBytes = profile.samples.reduce((total, sample) => total + sample.size, 0);
  }
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  observer.disconnect();
  const summarize = (samples: number[]) => {
    const sorted = samples.toSorted((a, b) => a - b);
    return {
      count: sorted.length,
      mean: samples.reduce((a, b) => a + b, 0) / samples.length,
      p50: sorted[Math.floor(sorted.length * 0.5)],
      p95: sorted[Math.floor(sorted.length * 0.95)],
      p99: sorted[Math.floor(sorted.length * 0.99)],
      max: sorted.at(-1),
    };
  };
  console.log(
    JSON.stringify({
      mode: values.mode,
      fanout,
      sends: blocked.length * fanout,
      wallMs,
      mainThreadCpuMs: (cpu.user + cpu.system) / 1000,
      allocatedBytes,
      blockedBatchMs: summarize(blocked),
      deliveryBatchMs: summarize(latency),
      gcMs: gc.reduce((a, b) => a + b, 0),
      gcCount: gc.length,
      received,
      memory: process.memoryUsage(),
      hostLoad: os.loadavg(),
    }),
  );
} finally {
  observer.disconnect();
  inspector.disconnect();
  webPush.sendNotification = originalSend;
  if (https.globalAgent !== originalAgent) {
    https.globalAgent.destroy();
  }
  https.globalAgent = originalAgent;
  server.closeAllConnections();
  if (server.listening) {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }
  await fs.rm(stateDir, { recursive: true, force: true });
}
