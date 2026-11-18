// Synthetic, offline Doctor phase. Run with node --import ./scripts/tsx.mjs.
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";

await mkdir(".artifacts", { recursive: true });
const root = await mkdtemp(path.resolve(".artifacts/doctor-tool-schemas-"));
process.env.HOME = path.join(root, "home");
process.env.OPENCLAW_HOME = process.env.HOME;
delete process.env.OPENCLAW_AGENT_DIR;
delete process.env.PI_CODING_AGENT_DIR;
process.env.OPENCLAW_STATE_DIR = path.join(root, "state");
process.env.OPENCLAW_CONFIG_PATH = path.join(root, "state/openclaw.json");
await mkdir(process.env.HOME, { recursive: true });
await mkdir(process.env.OPENCLAW_STATE_DIR, { recursive: true });

const { collectRuntimeToolSchemaFindings } =
  await import("../../src/flows/doctor-tool-schema-runtime.js");
const cfg: OpenClawConfig = {
  agents: {
    ownership: "explicit",
    defaults: { systemAgent: { agentId: "agent0" }, model: "fixture/local" },
    entries: Object.fromEntries(
      Array.from({ length: 200 }, (_, i) => [
        `agent${i}`,
        { workspace: path.join(root, `workspace${i}`) },
      ]),
    ),
  },
  models: {
    providers: {
      fixture: {
        api: "openai-completions",
        baseUrl: "http://127.0.0.1:1/v1",
        models: [
          {
            id: "local",
            name: "Local fixture",
            contextWindow: 128000,
            maxTokens: 4096,
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ],
      },
    },
  },
  plugins: { slots: { memory: "none" } },
};
const clone = globalThis.structuredClone;
let indexClones = 0;
globalThis.structuredClone = (value, options) => {
  if (
    value &&
    typeof value === "object" &&
    Object.hasOwn(value, "policyHash") &&
    Object.hasOwn(value, "plugins")
  ) {
    indexClones++;
  }
  return clone(value, options);
};
try {
  const started = performance.now();
  const findings = await collectRuntimeToolSchemaFindings(cfg, { mode: "doctor" });
  console.log(
    JSON.stringify({
      node: process.version,
      agents: 200,
      elapsedMs: performance.now() - started,
      indexClones,
      heapMiB: process.memoryUsage().heapUsed / 2 ** 20,
      maxRssMiB: process.resourceUsage().maxRSS / 1024,
      findings,
    }),
  );
  if (findings.length) {
    throw new Error("Synthetic Doctor phase returned findings");
  }
} finally {
  globalThis.structuredClone = clone;
  const { cleanupSessionStateForTest } =
    await import("../../src/test-utils/session-state-cleanup.js");
  await cleanupSessionStateForTest({ stateDir: process.env.OPENCLAW_STATE_DIR, rootPath: root });
  await rm(root, { recursive: true, force: true });
}
