import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { startQaGatewayRpcClient } from "./gateway-rpc-client.js";
import { seedQaAgentWorkspace } from "./qa-agent-workspace.js";
import { buildQaGatewayConfig } from "./qa-gateway-config.js";

const QA_LIVE_ENV_ALIASES = Object.freeze([
  {
    liveVar: "OPENCLAW_LIVE_OPENAI_KEY",
    providerVar: "OPENAI_API_KEY",
  },
  {
    liveVar: "OPENCLAW_LIVE_ANTHROPIC_KEY",
    providerVar: "ANTHROPIC_API_KEY",
  },
  {
    liveVar: "OPENCLAW_LIVE_GEMINI_KEY",
    providerVar: "GEMINI_API_KEY",
  },
]);

const QA_MOCK_BLOCKED_ENV_VARS = Object.freeze([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_OAUTH_TOKEN",
  "AWS_ACCESS_KEY_ID",
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_REGION",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "GEMINI_API_KEY",
  "GEMINI_API_KEYS",
  "GOOGLE_API_KEY",
  "MISTRAL_API_KEY",
  "OPENAI_API_KEY",
  "OPENAI_API_KEYS",
  "OPENAI_BASE_URL",
  "OPENCLAW_LIVE_ANTHROPIC_KEY",
  "OPENCLAW_LIVE_ANTHROPIC_KEYS",
  "OPENCLAW_LIVE_GEMINI_KEY",
  "OPENCLAW_LIVE_OPENAI_KEY",
  "VOYAGE_API_KEY",
]);

async function getFreePort() {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("failed to allocate port"));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

export function normalizeQaProviderModeEnv(
  env: NodeJS.ProcessEnv,
  providerMode?: "mock-openai" | "live-frontier",
) {
  if (providerMode === "mock-openai") {
    for (const key of QA_MOCK_BLOCKED_ENV_VARS) {
      delete env[key];
    }
    return env;
  }

  if (providerMode === "live-frontier") {
    for (const { liveVar, providerVar } of QA_LIVE_ENV_ALIASES) {
      const liveValue = env[liveVar]?.trim();
      if (!liveValue || env[providerVar]?.trim()) {
        continue;
      }
      env[providerVar] = liveValue;
    }
  }

  return env;
}

export function buildQaRuntimeEnv(params: {
  configPath: string;
  gatewayToken: string;
  homeDir: string;
  stateDir: string;
  xdgConfigHome: string;
  xdgDataHome: string;
  xdgCacheHome: string;
  providerMode?: "mock-openai" | "live-frontier";
  baseEnv?: NodeJS.ProcessEnv;
}) {
  const env: NodeJS.ProcessEnv = {
    ...(params.baseEnv ?? process.env),
    HOME: params.homeDir,
    OPENCLAW_HOME: params.homeDir,
    OPENCLAW_CONFIG_PATH: params.configPath,
    OPENCLAW_STATE_DIR: params.stateDir,
    OPENCLAW_OAUTH_DIR: path.join(params.stateDir, "credentials"),
    OPENCLAW_GATEWAY_TOKEN: params.gatewayToken,
    OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
    OPENCLAW_SKIP_GMAIL_WATCHER: "1",
    OPENCLAW_SKIP_CANVAS_HOST: "1",
    OPENCLAW_NO_RESPAWN: "1",
    OPENCLAW_TEST_FAST: "1",
    OPENCLAW_QA_ALLOW_LOCAL_IMAGE_PROVIDER: "1",
    // QA uses the fast runtime envelope for speed, but it still exercises
    // normal config-driven heartbeats and runtime config writes.
    OPENCLAW_ALLOW_SLOW_REPLY_TESTS: "1",
    XDG_CONFIG_HOME: params.xdgConfigHome,
    XDG_DATA_HOME: params.xdgDataHome,
    XDG_CACHE_HOME: params.xdgCacheHome,
  };
  return normalizeQaProviderModeEnv(env, params.providerMode);
}

function isRetryableGatewayCallError(details: string): boolean {
  return (
    details.includes("gateway closed (1012)") ||
    details.includes("gateway closed (1006") ||
    details.includes("abnormal closure") ||
    details.includes("service restart")
  );
}

export const __testing = {
  buildQaRuntimeEnv,
  isRetryableGatewayCallError,
};
async function waitForGatewayReady(params: {
  baseUrl: string;
  logs: () => string;
  child: {
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
  };
  timeoutMs?: number;
}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < (params.timeoutMs ?? 60_000)) {
    if (params.child.exitCode !== null || params.child.signalCode !== null) {
      throw new Error(
        `gateway exited before becoming healthy (exitCode=${String(params.child.exitCode)}, signal=${String(params.child.signalCode)}):\n${params.logs()}`,
      );
    }
    for (const healthPath of ["/readyz", "/healthz"]) {
      try {
        const response = await fetch(`${params.baseUrl}${healthPath}`, {
          signal: AbortSignal.timeout(2_000),
        });
        if (response.ok) {
          return;
        }
      } catch {
        // retry until timeout
      }
    }
    await sleep(250);
  }
  throw new Error(`gateway failed to become healthy:\n${params.logs()}`);
}

export function resolveQaControlUiRoot(params: { repoRoot: string; controlUiEnabled?: boolean }) {
  if (params.controlUiEnabled === false) {
    return undefined;
  }
  const controlUiRoot = path.join(params.repoRoot, "dist", "control-ui");
  const indexPath = path.join(controlUiRoot, "index.html");
  return existsSync(indexPath) ? controlUiRoot : undefined;
}

export async function startQaGatewayChild(params: {
  repoRoot: string;
  providerBaseUrl?: string;
  qaBusBaseUrl: string;
  controlUiAllowedOrigins?: string[];
  providerMode?: "mock-openai" | "live-frontier";
  primaryModel?: string;
  alternateModel?: string;
  fastMode?: boolean;
  controlUiEnabled?: boolean;
}) {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-qa-suite-"));
  const runtimeCwd = tempRoot;
  const distEntryPath = path.join(params.repoRoot, "dist", "index.js");
  const workspaceDir = path.join(tempRoot, "workspace");
  const stateDir = path.join(tempRoot, "state");
  const homeDir = path.join(tempRoot, "home");
  const xdgConfigHome = path.join(tempRoot, "xdg-config");
  const xdgDataHome = path.join(tempRoot, "xdg-data");
  const xdgCacheHome = path.join(tempRoot, "xdg-cache");
  const configPath = path.join(tempRoot, "openclaw.json");
  const gatewayPort = await getFreePort();
  const gatewayToken = `qa-suite-${randomUUID()}`;
  await seedQaAgentWorkspace({
    workspaceDir,
    repoRoot: params.repoRoot,
  });
  await Promise.all([
    fs.mkdir(stateDir, { recursive: true }),
    fs.mkdir(homeDir, { recursive: true }),
    fs.mkdir(xdgConfigHome, { recursive: true }),
    fs.mkdir(xdgDataHome, { recursive: true }),
    fs.mkdir(xdgCacheHome, { recursive: true }),
  ]);
  const cfg = buildQaGatewayConfig({
    bind: "loopback",
    gatewayPort,
    gatewayToken,
    providerBaseUrl: params.providerBaseUrl,
    qaBusBaseUrl: params.qaBusBaseUrl,
    workspaceDir,
    controlUiRoot: resolveQaControlUiRoot({
      repoRoot: params.repoRoot,
      controlUiEnabled: params.controlUiEnabled,
    }),
    controlUiAllowedOrigins: params.controlUiAllowedOrigins,
    providerMode: params.providerMode,
    primaryModel: params.primaryModel,
    alternateModel: params.alternateModel,
    fastMode: params.fastMode,
    controlUiEnabled: params.controlUiEnabled,
  });
  await fs.writeFile(configPath, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");

  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  const env = buildQaRuntimeEnv({
    configPath,
    gatewayToken,
    homeDir,
    stateDir,
    xdgConfigHome,
    xdgDataHome,
    xdgCacheHome,
    providerMode: params.providerMode,
  });

  const child = spawn(
    process.execPath,
    [
      distEntryPath,
      "gateway",
      "run",
      "--port",
      String(gatewayPort),
      "--bind",
      "loopback",
      "--allow-unconfigured",
    ],
    {
      cwd: runtimeCwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
  child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));

  const baseUrl = `http://127.0.0.1:${gatewayPort}`;
  const wsUrl = `ws://127.0.0.1:${gatewayPort}`;
  const logs = () =>
    `${Buffer.concat(stdout).toString("utf8")}\n${Buffer.concat(stderr).toString("utf8")}`.trim();
  const keepTemp = process.env.OPENCLAW_QA_KEEP_TEMP === "1";

  let rpcClient;
  try {
    await waitForGatewayReady({
      baseUrl,
      logs,
      child,
    });
    rpcClient = await startQaGatewayRpcClient({
      wsUrl,
      token: gatewayToken,
      logs,
    });
  } catch (error) {
    child.kill("SIGTERM");
    throw error;
  }

  return {
    cfg,
    baseUrl,
    wsUrl,
    pid: child.pid ?? null,
    token: gatewayToken,
    workspaceDir,
    tempRoot,
    configPath,
    runtimeEnv: env,
    logs,
    async restart(signal: NodeJS.Signals = "SIGUSR1") {
      if (!child.pid) {
        throw new Error("qa gateway child has no pid");
      }
      process.kill(child.pid, signal);
    },
    async call(
      method: string,
      rpcParams?: unknown,
      opts?: { expectFinal?: boolean; timeoutMs?: number },
    ) {
      const timeoutMs = opts?.timeoutMs ?? 20_000;
      let lastDetails = "";
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          return await rpcClient.request(method, rpcParams, {
            ...opts,
            timeoutMs,
          });
        } catch (error) {
          const details = formatErrorMessage(error);
          lastDetails = details;
          if (attempt >= 3 || !isRetryableGatewayCallError(details)) {
            throw new Error(`${details}\nGateway logs:\n${logs()}`, { cause: error });
          }
          await waitForGatewayReady({
            baseUrl,
            logs,
            child,
            timeoutMs: Math.max(10_000, timeoutMs),
          });
        }
      }
      throw new Error(`${lastDetails}\nGateway logs:\n${logs()}`);
    },
    async stop(opts?: { keepTemp?: boolean }) {
      await rpcClient.stop().catch(() => {});
      if (!child.killed) {
        child.kill("SIGTERM");
        await Promise.race([
          new Promise<void>((resolve) => child.once("exit", () => resolve())),
          sleep(5_000).then(() => {
            if (!child.killed) {
              child.kill("SIGKILL");
            }
          }),
        ]);
      }
      if (!(opts?.keepTemp ?? keepTemp)) {
        await fs.rm(tempRoot, { recursive: true, force: true });
      }
    },
  };
}
