import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { seedQaAgentWorkspace } from "./qa-agent-workspace.js";
import { buildQaGatewayConfig } from "./qa-gateway-config.js";

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

function buildQaRuntimeEnv(params: {
  configPath: string;
  gatewayToken: string;
  homeDir: string;
  stateDir: string;
  xdgConfigHome: string;
  xdgDataHome: string;
  xdgCacheHome: string;
  providerMode?: "mock-openai" | "live-openai";
}) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
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
    // QA uses the fast runtime envelope for speed, but it still exercises
    // normal config-driven heartbeats and runtime config writes.
    OPENCLAW_ALLOW_SLOW_REPLY_TESTS: "1",
    XDG_CONFIG_HOME: params.xdgConfigHome,
    XDG_DATA_HOME: params.xdgDataHome,
    XDG_CACHE_HOME: params.xdgCacheHome,
  };
  if (params.providerMode === "mock-openai") {
    for (const key of [
      "OPENAI_API_KEY",
      "OPENAI_BASE_URL",
      "GEMINI_API_KEY",
      "GOOGLE_API_KEY",
      "VOYAGE_API_KEY",
      "MISTRAL_API_KEY",
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_SESSION_TOKEN",
      "AWS_REGION",
      "AWS_BEARER_TOKEN_BEDROCK",
    ]) {
      delete env[key];
    }
  }
  return env;
}

export const __testing = {
  buildQaRuntimeEnv,
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
    try {
      const response = await fetch(`${params.baseUrl}/healthz`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) {
        return;
      }
    } catch {
      // retry until timeout
    }
    await sleep(250);
  }
  throw new Error(`gateway failed to become healthy:\n${params.logs()}`);
}

async function runCliJson(params: { cwd: string; env: NodeJS.ProcessEnv; args: string[] }) {
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, params.args, {
      cwd: params.cwd,
      env: params.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `gateway cli failed (${code ?? "unknown"}): ${Buffer.concat(stderr).toString("utf8")}`,
        ),
      );
    });
  });
  const text = Buffer.concat(stdout).toString("utf8").trim();
  return text ? (JSON.parse(text) as unknown) : {};
}

export async function startQaGatewayChild(params: {
  repoRoot: string;
  providerBaseUrl?: string;
  qaBusBaseUrl: string;
  providerMode?: "mock-openai" | "live-openai";
  primaryModel?: string;
  alternateModel?: string;
  controlUiEnabled?: boolean;
}) {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-qa-suite-"));
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
    providerMode: params.providerMode,
    primaryModel: params.primaryModel,
    alternateModel: params.alternateModel,
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
      "dist/index.js",
      "gateway",
      "run",
      "--port",
      String(gatewayPort),
      "--bind",
      "loopback",
      "--allow-unconfigured",
    ],
    {
      cwd: params.repoRoot,
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

  try {
    await waitForGatewayReady({
      baseUrl,
      logs,
      child,
    });
  } catch (error) {
    child.kill("SIGTERM");
    throw error;
  }

  return {
    cfg,
    baseUrl,
    wsUrl,
    token: gatewayToken,
    workspaceDir,
    tempRoot,
    configPath,
    runtimeEnv: env,
    logs,
    async call(
      method: string,
      rpcParams?: unknown,
      opts?: { expectFinal?: boolean; timeoutMs?: number },
    ) {
      return await runCliJson({
        cwd: params.repoRoot,
        env,
        args: [
          "dist/index.js",
          "gateway",
          "call",
          method,
          "--url",
          wsUrl,
          "--token",
          gatewayToken,
          "--json",
          "--timeout",
          String(opts?.timeoutMs ?? 20_000),
          ...(opts?.expectFinal ? ["--expect-final"] : []),
          "--params",
          JSON.stringify(rpcParams ?? {}),
        ],
      }).catch((error) => {
        const details = formatErrorMessage(error);
        throw new Error(`${details}\nGateway logs:\n${logs()}`);
      });
    },
    async stop(opts?: { keepTemp?: boolean }) {
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
