/**
 * Synthetic sandbox image replay through the real hydration/provider owners.
 * Prepare once outside measurements (62,000 files, about 1.1 GiB):
 * node --import ./scripts/tsx.mjs scripts/perf/native-image-replay-measure.ts --root <new-dir> --prepare
 * Copy this unchanged script to both revisions, then run serial A/A and ABAB arms:
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/native-image-replay-measure.ts --root <dir> --label A1
 * Use --mode allocation separately; --sessions 2000 exercises session turnover.
 * Acceptance: initially deliver every image; after deletion emit one failure notice
 * per request and at most one failed validation per session. Repeated validation
 * must fall without a >20% CPU, allocation, or latency regression after A/A controls.
 * This owner does no session DB or workspace scan: no synthetic 35-GiB DB is opened.
 * This is filesystem/owner proof, not Gateway, btrfs, live-model, or production proof.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { log } from "../../src/agents/embedded-agent-runner/logger.js";
import {
  buildPromptImageFailureNotice,
  hydratePromptMediaMessages,
  materializeProviderContext,
} from "../../src/agents/embedded-agent-runner/run/images.js";
import type { AgentMessage } from "../../src/agents/runtime/index.js";
import { convertToLlm } from "../../src/agents/sessions/messages.js";
import { createHostSandboxFsBridge } from "../../src/agents/test-helpers/host-sandbox-fs-bridge.js";

const { values } = parseArgs({
  options: {
    root: { type: "string" },
    prepare: { type: "boolean", default: false },
    files: { type: "string", default: "62000" },
    "file-bytes": { type: "string", default: "19052" },
    sessions: { type: "string", default: "32" },
    requests: { type: "string", default: "8" },
    mode: { type: "string", default: "timing" },
    label: { type: "string", default: "candidate" },
  },
});
assert(values.root, "--root must name a task-owned synthetic fixture directory");
assert(values.mode === "timing" || values.mode === "allocation");
const root = path.resolve(values.root);
const files = Number(values.files);
const fileBytes = Number(values["file-bytes"]);
const sessions = Number(values.sessions);
const requests = Number(values.requests);
assert([files, fileBytes, sessions, requests].every((n) => Number.isSafeInteger(n) && n > 0));
const manifestPath = path.join(root, "native-image-fixture.json");
if (values.prepare) {
  // Refuse existing directories; never replace an operator's workspace.
  await fs.mkdir(root);
  const payload = Buffer.alloc(fileBytes, 0x61);
  for (let index = 0; index < files; index++) {
    const dir = path.join(root, "inventory", String(Math.floor(index / 100)));
    if (index % 100 === 0) {
      await fs.mkdir(dir, { recursive: true });
    }
    await fs.writeFile(path.join(dir, `${index}.txt`), payload, { flag: "wx" });
  }
  const fixture = { files, fileBytes, totalBytes: files * fileBytes, synthetic: true };
  await fs.writeFile(manifestPath, JSON.stringify(fixture), { flag: "wx" });
  console.log(JSON.stringify({ prepared: root, ...fixture }));
  process.exit(0);
}
const fixture: unknown = JSON.parse(await fs.readFile(manifestPath, "utf8"));
assert(fixture && typeof fixture === "object" && "synthetic" in fixture && fixture.synthetic);
const imagePath = path.join(root, "media/inbound/native-image-replay.png");
await fs.mkdir(path.dirname(imagePath), { recursive: true });
const image = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAsTAAALEwEAmpwYAAAADUlEQVR4nGP4////KwAJ5gPoxLp9owAAAABJRU5ErkJggg==",
  "base64",
);
const message: AgentMessage = {
  role: "user",
  content: "Inspect the synthetic attachment.",
  timestamp: 1,
};
Reflect.set(message, "__openclaw", {
  media: [{ url: "media://inbound/native-image-replay.png", contentType: "image/png" }],
  mediaImageLayout: { slots: [{ kind: "offloaded", factIndex: 0 }] },
});
const bridge = createHostSandboxFsBridge(root);
const originalStat = bridge.stat.bind(bridge);
let phase: "initial" | "missing" = "initial";
let initialValidations = 0;
let failedValidations = 0;
let warnings = 0;
bridge.stat = async (params) => {
  if (phase === "initial") {
    initialValidations++;
  } else {
    failedValidations++;
  }
  return originalStat(params);
};
const originalWarn = log.warn;
log.warn = (text) => {
  assert.equal(
    text,
    "Native image: sandbox validation failed (reason=not-staged, pathClass=managed-media)",
  );
  warnings++;
};
const notice = buildPromptImageFailureNotice(1);
const elapsed: number[] = [];
let cpuMicros = 0;
let initialCpuMicros = 0;
let initialElapsedMs = 0;
let delivered = 0;
let visibleFailures = 0;
let failureCallbacks = 0;
const inspector = new Session();
let sampledBytes: number | undefined;
const loadBefore = os.loadavg();
const memoryBefore = process.memoryUsage();
try {
  // Warm image parsing and module lazy imports outside all recorded samples.
  await fs.writeFile(imagePath, image);
  await hydratePromptMediaMessages([message], {
    workspaceDir: root,
    model: { input: ["text", "image"] },
    sandbox: { root, bridge },
  });
  initialValidations = 0;
  global.gc?.();
  if (values.mode === "allocation") {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 32768,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  for (let session = 0; session < sessions; session++) {
    const options = {
      workspaceDir: root,
      workspaceOnly: true,
      model: { input: ["text", "image"] },
      sandbox: { root, bridge },
      imageSessionKey: `synthetic-native-replay/${session}`,
      onCurrentTurnImageFailure: () => {
        failureCallbacks++;
      },
    };
    const request = async () => {
      const hydrated = await hydratePromptMediaMessages([message], options);
      return materializeProviderContext({
        ...options,
        context: { messages: convertToLlm(hydrated) },
      });
    };
    phase = "initial";
    await fs.writeFile(imagePath, image);
    const initialCpu = process.cpuUsage();
    const initialStart = performance.now();
    const first = await request();
    initialElapsedMs += performance.now() - initialStart;
    const initialUsed = process.cpuUsage(initialCpu);
    initialCpuMicros += initialUsed.user + initialUsed.system;
    const initialContent = first.messages[0]?.content;
    assert(Array.isArray(initialContent) && initialContent.some((part) => part.type === "image"));
    delivered++;
    await fs.unlink(imagePath);
    phase = "missing";
    for (let index = 0; index < requests; index++) {
      const cpu = process.cpuUsage();
      const start = performance.now();
      const result = await request();
      elapsed.push(performance.now() - start);
      const used = process.cpuUsage(cpu);
      cpuMicros += used.user + used.system;
      const content = result.messages[0]?.content;
      assert(Array.isArray(content) && !content.some((part) => part.type === "image"));
      assert.equal(
        content.filter((part) => part.type === "text" && part.text === notice).length,
        1,
      );
      visibleFailures++;
    }
  }
  if (values.mode === "allocation") {
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    const sum = (node: HeapProfiler.SamplingHeapProfileNode): number =>
      node.selfSize + node.children.reduce((total, child) => total + sum(child), 0);
    sampledBytes = sum(profile.head);
  }
} finally {
  log.warn = originalWarn;
  inspector.disconnect();
  await fs.rm(imagePath, { force: true });
}
elapsed.sort((a, b) => a - b);
const percentile = (p: number) =>
  elapsed[Math.min(elapsed.length - 1, Math.floor(elapsed.length * p))];
console.log(
  JSON.stringify({
    label: values.label,
    mode: values.mode,
    fixture,
    sessions,
    requestsPerSession: requests,
    initialValidations,
    failedValidations,
    warnings,
    delivered,
    visibleFailures,
    failureCallbacks,
    replayElapsedMs: elapsed.reduce((sum, ms) => sum + ms, 0),
    replayMedianMs: percentile(0.5),
    replayP95Ms: percentile(0.95),
    replayCpuMs: cpuMicros / 1000,
    initialElapsedMs,
    initialCpuMs: initialCpuMicros / 1000,
    // Allocation includes initial inclusion and fixture writes/unlinks, identically in both arms.
    sampledBytes,
    loadBefore,
    loadAfter: os.loadavg(),
    memoryBefore,
    memoryAfter: process.memoryUsage(),
  }),
);
