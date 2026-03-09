import { spawn, type ChildProcess } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { LiveKitVoiceConfig } from "./config.js";

interface RuntimeLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export interface AgentRuntime {
  process: ChildProcess | null;
  isRunning: boolean;
  start(): Promise<void>;
  stop(): Promise<void>;
}

const RESTART_BACKOFF_MS = [1000, 2000, 5000, 10000, 30000];

export function createAgentRuntime(
  config: LiveKitVoiceConfig,
  gatewayToken: string,
  logger: RuntimeLogger,
): AgentRuntime {
  let proc: ChildProcess | null = null;
  let isRunning = false;
  let shouldRestart = true;
  let restartCount = 0;
  let restartTimer: NodeJS.Timeout | null = null;

  const agentDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "agent");

  function getEnv(): Record<string, string> {
    return {
      ...process.env as Record<string, string>,
      LIVEKIT_URL: config.livekit.url,
      LIVEKIT_API_KEY: config.livekit.apiKey || "",
      LIVEKIT_API_SECRET: config.livekit.apiSecret || "",
      GOOGLE_CLOUD_PROJECT: config.agent.project,
      GOOGLE_CLOUD_LOCATION: config.agent.location,
      GEMINI_MODEL: config.agent.model,
      GEMINI_VOICE: config.agent.voice,
      OWNER_NAME: config.owner.name,
      OWNER_IDENTITY: config.owner.identity,
      OWNER_SESSION_KEY: config.owner.sessionKey,
      OPENCLAW_GATEWAY_URL: `http://localhost:${process.env.OPENCLAW_GATEWAY_PORT || "18789"}`,
      OPENCLAW_GATEWAY_TOKEN: gatewayToken,
      OPENCLAW_AGENT_ID: "main",
    };
  }

  async function start() {
    if (isRunning) return;

    shouldRestart = true;
    restartCount = 0;

    spawnProcess();
  }

  function spawnProcess() {
    logger.info("[livekit-voice] Starting agent process...");

    proc = spawn("npx", ["tsx", "main.ts", "dev"], {
      cwd: agentDir,
      env: getEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });

    isRunning = true;

    proc.stdout?.on("data", (data: Buffer) => {
      for (const line of data.toString().split("\n").filter(Boolean)) {
        logger.info(`[livekit-agent] ${line}`);
      }
    });

    proc.stderr?.on("data", (data: Buffer) => {
      for (const line of data.toString().split("\n").filter(Boolean)) {
        logger.error(`[livekit-agent] ${line}`);
      }
    });

    proc.on("exit", (code, signal) => {
      isRunning = false;
      proc = null;
      logger.warn(`[livekit-voice] Agent exited (code=${code}, signal=${signal})`);

      if (shouldRestart) {
        const backoff = RESTART_BACKOFF_MS[Math.min(restartCount, RESTART_BACKOFF_MS.length - 1)];
        restartCount++;
        logger.info(`[livekit-voice] Restarting in ${backoff}ms (attempt ${restartCount})...`);
        restartTimer = setTimeout(() => {
          restartTimer = null;
          spawnProcess();
        }, backoff);
      }
    });

    proc.on("error", (err) => {
      logger.error(`[livekit-voice] Agent spawn error: ${err.message}`);
    });
  }

  async function stop() {
    shouldRestart = false;
    if (restartTimer) {
      clearTimeout(restartTimer);
      restartTimer = null;
    }

    if (proc) {
      logger.info("[livekit-voice] Stopping agent process...");
      proc.kill("SIGTERM");

      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          if (proc) {
            proc.kill("SIGKILL");
          }
          resolve();
        }, 5000);

        proc?.on("exit", () => {
          clearTimeout(timeout);
          resolve();
        });
      });

      proc = null;
      isRunning = false;
    }
  }

  return {
    get process() {
      return proc;
    },
    get isRunning() {
      return isRunning;
    },
    start,
    stop,
  };
}
