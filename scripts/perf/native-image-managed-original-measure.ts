/**
 * Managed originals after sandbox preparation, through real hydration/provider owners.
 * Prepare: node --import ./scripts/tsx.mjs scripts/perf/native-image-managed-original-measure.ts --root <new-dir> --prepare
 * Measure serial A/A controls and five interleaved A/B pairs with --sessions 2000.
 * Use --owner <absolute images.ts snapshot> to pin baseline and --mode allocation separately.
 * Acceptance: every admitted original reaches provider input, with zero legacy sandbox stats.
 * Baseline drops images; candidate decodes them. CPU/time growth is the cost of restoring
 * missing work, not a performance regression or a speedup. Report both, never ratios as gains.
 * Fixture: 62,000 files/~1.1 GiB. Hydration never opens session DBs or scans the workspace;
 * no synthetic 35-GiB database is created. This is owner proof, not live Gateway/btrfs proof.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { AgentMessage } from "../../src/agents/runtime/index.js";

const { values } = parseArgs({
  options: {
    root: { type: "string" },
    prepare: { type: "boolean", default: false },
    sessions: { type: "string", default: "2000" },
    owner: { type: "string" },
    mode: { type: "string", default: "timing" },
    label: { type: "string", default: "candidate" },
  },
});
assert(values.root, "--root must name a task-owned synthetic fixture directory");
assert(values.mode === "timing" || values.mode === "allocation");
const root = path.resolve(values.root);
const sessions = Number(values.sessions);
assert(Number.isSafeInteger(sessions) && sessions > 0);
const workspace = path.join(root, "workspace");
const manifestPath = path.join(root, "native-image-fixture.json");
if (values.prepare) {
  await fs.mkdir(root); // Never replace an existing operator directory.
  const files = 62_000;
  const payload = Buffer.alloc(19_052, 0x61);
  for (let index = 0; index < files; index++) {
    const directory = path.join(workspace, "inventory", String(Math.floor(index / 100)));
    if (index % 100 === 0) {
      await fs.mkdir(directory, { recursive: true });
    }
    await fs.writeFile(path.join(directory, `${index}.txt`), payload, { flag: "wx" });
  }
  const fixture = { files, totalBytes: files * payload.length, synthetic: true };
  await fs.writeFile(manifestPath, JSON.stringify(fixture), { flag: "wx" });
  console.log(JSON.stringify({ prepared: root, ...fixture }));
  process.exit(0);
}
const fixture: unknown = JSON.parse(await fs.readFile(manifestPath, "utf8"));
assert(fixture && typeof fixture === "object" && "synthetic" in fixture && fixture.synthetic);
process.env.OPENCLAW_STATE_DIR = path.join(root, "state");
const { getMediaDir } = await import("../../src/media/store-path.js");
const { log } = await import("../../src/agents/embedded-agent-runner/logger.js");
const { hydratePromptMediaMessages, materializeProviderContext, buildPromptImageFailureNotice } =
  (await import(
    values.owner
      ? pathToFileURL(path.resolve(values.owner)).href
      : "../../src/agents/embedded-agent-runner/run/images.js"
  )) as typeof import("../../src/agents/embedded-agent-runner/run/images.js");
const { convertToLlm } = await import("../../src/agents/sessions/messages.js");
const { createHostSandboxFsBridge } =
  await import("../../src/agents/test-helpers/host-sandbox-fs-bridge.js");
const image = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAsTAAALEwEAmpwYAAAADUlEQVR4nGP4////KwAJ5gPoxLp9owAAAABJRU5ErkJggg==",
  "base64",
);
const imagePath = path.join(getMediaDir(), "inbound", "synthetic-original.png");
assert(imagePath.startsWith(path.join(root, "state") + path.sep));
await fs.mkdir(path.dirname(imagePath), { recursive: true });
await fs.writeFile(imagePath, image);
const bridge = createHostSandboxFsBridge(workspace);
const stat = bridge.stat.bind(bridge);
let validations = 0;
bridge.stat = (params) => {
  validations++;
  return stat(params);
};
let warnings = 0;
const originalWarn = log.warn;
log.warn = () => {
  warnings++;
};
const request = async (session: number) => {
  const message: AgentMessage = {
    role: "user",
    content: "Inspect the synthetic attachment.",
    timestamp: 1,
  };
  Reflect.set(message, "__openclaw", {
    media: [{ url: "media://inbound/synthetic-original.png", contentType: "image/png" }],
    mediaImageLayout: { slots: [{ kind: "offloaded", factIndex: 0 }] },
  });
  const options = {
    workspaceDir: workspace,
    workspaceOnly: true,
    model: { input: ["text", "image"] },
    sandbox: { root: workspace, bridge },
    imageSessionKey: `synthetic-managed-original/${session}`,
  };
  const hydrated = await hydratePromptMediaMessages([message], options);
  return materializeProviderContext({ ...options, context: { messages: convertToLlm(hydrated) } });
};
const elapsed: number[] = [];
let delivered = 0;
let visibleFailures = 0;
let cpuMicros = 0;
let sampledBytes: number | undefined;
const inspector = new Session();
const loadBefore = os.loadavg();
try {
  for (let index = 0; index < 8; index++) {
    await request(-index - 1);
  }
  validations = 0;
  warnings = 0;
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
    const cpu = process.cpuUsage();
    const start = performance.now();
    const result = await request(session);
    elapsed.push(performance.now() - start);
    const used = process.cpuUsage(cpu);
    cpuMicros += used.user + used.system;
    const content = result.messages[0]?.content;
    assert(Array.isArray(content));
    delivered += Number(content.some((part) => part.type === "image"));
    visibleFailures += Number(
      content.some(
        (part) => part.type === "text" && part.text === buildPromptImageFailureNotice(1),
      ),
    );
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
}
elapsed.sort((a, b) => a - b);
console.log(
  JSON.stringify({
    label: values.label,
    mode: values.mode,
    fixture,
    sessions,
    delivered,
    visibleFailures,
    validations,
    warnings,
    totalMs: elapsed.reduce((sum, ms) => sum + ms, 0),
    medianMs: elapsed[Math.floor(elapsed.length * 0.5)],
    p95Ms: elapsed[Math.floor(elapsed.length * 0.95)],
    cpuMs: cpuMicros / 1000,
    sampledBytes,
    loadBefore,
    loadAfter: os.loadavg(),
  }),
);
