import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import * as json5 from "json5";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { acquireGatewayLock, type GatewayLockHandle } from "../../infra/gateway-lock.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import { registerSealedRuntime } from "../../infra/sealed-runtime-registry.js";
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
let callerSql = 0;
const native = requireNodeSqlite();
for (const method of ["prepare", "exec"] as const) {
  Object.defineProperty(native.DatabaseSync.prototype, method, {
    ...Object.getOwnPropertyDescriptor(native.DatabaseSync.prototype, method),
    value: new Proxy(native.DatabaseSync.prototype[method], {
      apply(target, receiver, args) {
        callerSql++;
        return Reflect.apply(target, receiver, args);
      },
    }),
  });
}
for (const method of ["get", "all", "run", "iterate"] as const) {
  Object.defineProperty(native.StatementSync.prototype, method, {
    ...Object.getOwnPropertyDescriptor(native.StatementSync.prototype, method),
    value: new Proxy(native.StatementSync.prototype[method], {
      apply(target, receiver, args) {
        callerSql++;
        return Reflect.apply(target, receiver, args);
      },
    }),
  });
}
let backendCalls = 0;
const restoreBackend = registerSandboxBackend("docker", async (params) => {
  backendCalls++;
  return {
    id: "docker",
    runtimeId: `synthetic-${params.sessionKey}`,
    runtimeLabel: "synthetic SDK owner proof",
    workdir: "/workspace",
    async buildExecSpec() {
      throw new Error("This fixture never executes a sandbox command");
    },
    async runShellCommand() {
      throw new Error("This fixture never executes a sandbox command");
    },
  };
});
const runtime = createPluginRuntime();
const config: OpenClawConfig = {
  agents: {
    defaults: {
      skipBootstrap: true,
      sandbox: {
        mode: "all",
        scope: "session",
        workspaceAccess: "rw",
        prune: { idleHours: 0, maxAgeDays: 0 },
        browser: { enabled: false },
      },
    },
    list: [{ id: "main", default: true, workspace: path.join(root, "workspace") }],
  },
  tools: { elevated: { enabled: false }, sandbox: { tools: { allow: ["read"] } } },
  skills: { load: { watch: false } },
};
fs.writeFileSync(process.env.OPENCLAW_CONFIG_PATH!, JSON.stringify(config));

async function callApis(phase: string, selectedConfig = config, workspaceRoot = root) {
  const outcomes = [];
  const sqlBefore = callerSql;
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
  return { outcomes, callerSql: callerSql - sqlBefore, backendCalls: backendCalls - callsBefore };
}

const send = (phase: string, data: unknown = {}) =>
  process.stdout.write(`sdk-owner-proof:${JSON.stringify({ phase, data })}\n`);
const workerRoot = path.join(root, "worker-shaped");
fs.mkdirSync(workerRoot);
const sandboxOffConfig: OpenClawConfig = {
  ...config,
  agents: {
    ...config.agents,
    defaults: {
      ...config.agents?.defaults,
      sandbox: { ...config.agents?.defaults?.sandbox, mode: "off" },
    },
  },
};

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
