import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import * as json5 from "json5";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { acquireGatewayLock, type GatewayLockHandle } from "../../infra/gateway-lock.js";
import { registerSealedRuntime } from "../../infra/sealed-runtime-registry.js";
import { setLoggerOverride } from "../../logging/logger.js";
import { resolveSandboxContext } from "../../plugin-sdk/agent-harness-runtime.js";
import { createPluginRuntime } from "../../plugins/runtime/index.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import { registerSandboxBackend } from "./backend.js";
import { readRegistry } from "./registry.js";

const root = process.env.OPENCLAW_HOME!;
const control = path.join(root, "control");
fs.mkdirSync(control, { recursive: true });
registerSealedRuntime({ json5, resolveSecureTempRoot: () => control });
// Diagnostic logs are outside the state tree checked for foreign-owner mutations.
setLoggerOverride({ file: process.env.OPENCLAW_TEST_LOG_FILE });
let backendCalls = 0;
const unusedCommand = async () => {
  throw new Error("This fixture never executes a sandbox command");
};
const restoreBackend = registerSandboxBackend("docker", async (params) => {
  backendCalls++;
  return {
    id: "docker",
    runtimeId: `synthetic-${params.sessionKey}`,
    runtimeLabel: "synthetic SDK owner proof",
    workdir: "/workspace",
    buildExecSpec: unusedCommand,
    runShellCommand: unusedCommand,
  };
});
const runtime = createPluginRuntime();
function makeConfig(mode: "all" | "off"): OpenClawConfig {
  const sandbox = {
    mode,
    scope: "session",
    workspaceAccess: "rw",
    prune: { idleHours: 0, maxAgeDays: 0 },
    browser: { enabled: false },
  } as const;
  return {
    agents: {
      defaults: { skipBootstrap: true, sandbox },
      entries: { main: { workspace: path.join(root, "workspace") } },
    },
    tools: { elevated: { enabled: false }, sandbox: { tools: { allow: ["read"] } } },
    skills: { load: { watch: false } },
  };
}
const config = makeConfig("all");
fs.writeFileSync(process.env.OPENCLAW_CONFIG_PATH!, JSON.stringify(config));

async function callApis(phase: string, selectedConfig = config, workspaceRoot = root) {
  const outcomes = [];
  const callsBefore = backendCalls;
  for (const api of ["resolveSandboxContext", "prepareWorkspaceAuthority"] as const) {
    const params = {
      config: selectedConfig,
      agentId: "main",
      sessionKey: `agent:main:subagent:${phase}-${api}`,
      workspaceDir: path.join(workspaceRoot, "workspace", `${phase}-${api}`),
    };
    try {
      const context =
        api === "resolveSandboxContext" ? await resolveSandboxContext(params) : undefined;
      const result =
        api === "resolveSandboxContext"
          ? context && { enabled: context.enabled, backendId: context.backendId }
          : await runtime.sandbox.prepareWorkspaceAuthority(params);
      outcomes.push({ api, result });
    } catch (error) {
      outcomes.push({
        api,
        error: {
          code: error && typeof error === "object" && "code" in error ? error.code : undefined,
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }
  return { outcomes, backendCalls: backendCalls - callsBefore };
}

export type SdkStateOwnerReply = {
  phase: string;
  data: Awaited<ReturnType<typeof callApis>> & { entries?: Array<{ containerName: string }> };
};

const send = (phase: string, data: unknown = {}) =>
  process.stdout.write(`sdk-owner-proof:${JSON.stringify({ phase, data })}\n`);
const workerRoot = path.join(root, "worker-shaped");
fs.mkdirSync(workerRoot);
const sandboxOffConfig = makeConfig("off");

async function closeDatabases() {
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
}

let owner: GatewayLockHandle | null = null;
const lines = createInterface({ input: process.stdin });
try {
  send("ready");
  for await (const phase of lines) {
    if (phase === "gateway" || phase === "agent-embedded") {
      owner = await acquireGatewayLock({ role: phase, allowInTests: true, timeoutMs: 0 });
      if (!owner) {
        throw new Error("Missing retained process owner");
      }
      const result = await owner.run(() => callApis(phase));
      owner.assertCurrent();
      send(phase, { ...result, entries: (await readRegistry()).entries });
    } else if (phase === "release") {
      await closeDatabases();
      await owner?.release();
      owner = null;
      send(phase);
    } else if (phase === "worker-off") {
      const stateDir = process.env.OPENCLAW_STATE_DIR;
      const configPath = process.env.OPENCLAW_CONFIG_PATH;
      try {
        process.env.OPENCLAW_STATE_DIR = path.join(workerRoot, "state");
        process.env.OPENCLAW_CONFIG_PATH = path.join(workerRoot, "openclaw.json");
        // Match WORKER_TOOL_CONFIG's shape; this probes the SDK no-op, not a worker turn.
        const result = await callApis(phase, { plugins: { enabled: false } }, workerRoot);
        await closeDatabases();
        send(phase, result);
      } finally {
        process.env.OPENCLAW_STATE_DIR = stateDir;
        process.env.OPENCLAW_CONFIG_PATH = configPath;
      }
    } else if (phase.startsWith("foreign-") || phase.startsWith("offline-")) {
      const result = await callApis(phase, phase.endsWith("-off") ? sandboxOffConfig : config);
      const entries = phase === "offline-on" ? (await readRegistry()).entries : undefined;
      await closeDatabases();
      send(phase, { ...result, entries });
    } else {
      throw new Error(`Unknown fixture phase: ${phase}`);
    }
  }
} finally {
  await closeDatabases();
  await owner?.release();
  restoreBackend();
  lines.close();
}
