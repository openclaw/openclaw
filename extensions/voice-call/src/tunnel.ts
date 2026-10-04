import { spawn, type ChildProcess } from "node:child_process";
import { sliceUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { formatBoundedChildOutput } from "./bounded-child-output.js";
import type { VoiceCallStreamExposurePath } from "./config.js";
import {
  cleanupTailscaleExposureRoute,
  setupTailscaleExposureRoutes,
} from "./webhook/tailscale.js";

const NGROK_LOG_BUFFER_MAX_CHARS = 16_384;
const NGROK_ERROR_MARKER = "ERR_NGROK";
const NGROK_STDERR_TAIL_MAX_CHARS = NGROK_ERROR_MARKER.length - 1;
const NGROK_STOP_GRACE_MS = 2_000;
const NGROK_FORCE_KILL_WAIT_MS = 1_000;

async function terminateNgrokProcess(
  proc: Pick<ChildProcess, "kill" | "once" | "off">,
  isClosed: () => boolean,
): Promise<void> {
  if (isClosed()) {
    return;
  }
  await new Promise<void>((resolve) => {
    let finished = false;
    let forceKillWaitTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (finished) {
        return;
      }
      finished = true;
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
      }
      if (forceKillWaitTimer) {
        clearTimeout(forceKillWaitTimer);
      }
      proc.off("close", finish);
      resolve();
    };
    proc.once("close", finish);
    // Give ngrok a graceful window before forcing termination. The final bounded
    // close wait avoids returning before SIGKILL normally reaps the child without
    // letting an unobservable close event hang cleanup forever.
    const forceKillTimer = setTimeout(() => {
      forceKillWaitTimer = setTimeout(finish, NGROK_FORCE_KILL_WAIT_MS);
      if (!isClosed()) {
        proc.kill("SIGKILL");
      }
    }, NGROK_STOP_GRACE_MS);
    proc.kill("SIGTERM");
    if (isClosed()) {
      finish();
    }
  });
}

interface TunnelConfig {
  provider: "ngrok" | "tailscale-serve" | "tailscale-funnel" | "none";
  /** Local port to tunnel */
  port: number;
  /** External HTTPS port used by Tailscale providers */
  tailscalePort?: number;
  /** Path prefix for the tunnel (e.g., /voice/webhook) */
  path: string;
  /** Additional public-to-local WebSocket paths exposed by Tailscale */
  streamPaths?: VoiceCallStreamExposurePath[];
  /** ngrok auth token (optional, enables longer sessions) */
  ngrokAuthToken?: string;
  /** ngrok custom domain (paid feature) */
  ngrokDomain?: string;
}

export interface TunnelResult {
  /** The public URL */
  publicUrl: string;
  /** Function to stop the tunnel */
  stop: () => Promise<void>;
  /** Tunnel provider name */
  provider: string;
}

/** Start an ngrok CLI tunnel and retain its child until the tunnel is stopped. */
async function startNgrokTunnel(config: TunnelConfig): Promise<TunnelResult> {
  const args = ["http", String(config.port), "--log", "stdout", "--log-format", "json"];

  // Add custom domain if provided (paid ngrok feature)
  if (config.ngrokDomain) {
    args.push("--domain", config.ngrokDomain);
  }

  return new Promise((resolve, reject) => {
    const proc = spawn("ngrok", args, {
      stdio: ["ignore", "pipe", "pipe"],
      ...(config.ngrokAuthToken
        ? { env: { ...process.env, NGROK_AUTHTOKEN: config.ngrokAuthToken } }
        : {}),
    });

    // Startup settlement and OS process closure are separate: the deadline can
    // win before the child has been reaped.
    let startupSettled = false;
    let childClosed = false;
    let publicUrl: string | null = null;
    let outputBuffer = "";
    // Keep only enough UTF-16-safe suffix to recognize an error marker split
    // at the next stream chunk boundary; otherwise the caller loses the code.
    let stderrTail = "";

    const timeout = setTimeout(() => {
      if (!startupSettled) {
        startupSettled = true;
        void terminateNgrokProcess(proc, () => childClosed).then(() => {
          reject(new Error("ngrok startup timed out (30s)"));
        });
      }
    }, 30000);
    // Do not keep the host process alive solely waiting on ngrok startup.
    timeout.unref();

    const rejectIfPending = (message: string, kill = false) => {
      if (!startupSettled) {
        startupSettled = true;
        clearTimeout(timeout);
        if (kill && !childClosed) {
          proc.kill("SIGKILL");
        }
        reject(new Error(message));
      }
    };

    const processLine = (line: string) => {
      try {
        const log = JSON.parse(line);

        // ngrok logs the public URL in a 'started tunnel' message
        if (log.msg === "started tunnel" && log.url) {
          publicUrl = log.url;
        }

        if (log.addr && log.url && !publicUrl) {
          publicUrl = log.url;
        }

        if (publicUrl && !startupSettled) {
          startupSettled = true;
          clearTimeout(timeout);

          const fullUrl = publicUrl + config.path;

          console.log(`[voice-call] ngrok tunnel active: ${fullUrl}`);

          resolve({
            publicUrl: fullUrl,
            provider: "ngrok",
            stop: async () => {
              await terminateNgrokProcess(proc, () => childClosed);
            },
          });
        }
      } catch {
        // Not JSON, might be startup message
      }
    };

    // Decode pipes statefully so a multibyte UTF-8 code point split across
    // chunk boundaries does not become U+FFFD in startup logs / ERR_NGROK text.
    proc.stdout.setEncoding("utf8");
    proc.stderr.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => {
      const lines = (outputBuffer + chunk).split("\n");
      outputBuffer = lines.pop() || "";
      if (outputBuffer.length > NGROK_LOG_BUFFER_MAX_CHARS) {
        // Keep incomplete ngrok log lines bounded without leaving a lone surrogate.
        outputBuffer = sliceUtf16Safe(outputBuffer, -NGROK_LOG_BUFFER_MAX_CHARS);
      }

      for (const line of lines) {
        if (line.trim()) {
          processLine(line);
        }
      }
    });
    proc.stderr.on("data", (chunk: string) => {
      const combined = stderrTail + chunk;
      if (combined.includes(NGROK_ERROR_MARKER)) {
        rejectIfPending(`ngrok error: ${formatBoundedChildOutput(combined)}`, true);
      }
      stderrTail = sliceUtf16Safe(combined, -NGROK_STDERR_TAIL_MAX_CHARS);
    });
    // Keep stream error listeners after startup so late failures remain handled.
    for (const stream of ["stdout", "stderr"] as const) {
      proc[stream].on("error", (error) => {
        rejectIfPending(`ngrok ${stream} error: ${error.message}`, true);
      });
    }

    proc.on("error", (err) => {
      rejectIfPending(`Failed to start ngrok: ${err.message}`);
    });

    proc.on("close", (code) => {
      childClosed = true;
      if (!startupSettled) {
        startupSettled = true;
        clearTimeout(timeout);
        reject(new Error(`ngrok exited unexpectedly with code ${code}`));
      }
    });
  });
}

export async function startTunnel(config: TunnelConfig): Promise<TunnelResult | null> {
  switch (config.provider) {
    case "ngrok":
      return startNgrokTunnel(config);
    case "tailscale-serve":
    case "tailscale-funnel": {
      const mode = config.provider === "tailscale-serve" ? "serve" : "funnel";
      const tailscalePort = config.tailscalePort ?? 443;
      const exposurePaths: VoiceCallStreamExposurePath[] = [
        { publicPath: config.path, localPath: config.path },
        ...(config.streamPaths ?? []),
      ];
      const routes = exposurePaths.map(({ publicPath, localPath }) => {
        const normalizedPublicPath = publicPath.startsWith("/") ? publicPath : `/${publicPath}`;
        const normalizedLocalPath = localPath.startsWith("/") ? localPath : `/${localPath}`;
        return {
          path: normalizedPublicPath,
          localUrl: `http://127.0.0.1:${config.port}${normalizedLocalPath}`,
        };
      });
      const publicUrl = await setupTailscaleExposureRoutes({
        mode,
        port: tailscalePort,
        routes,
      });
      if (!publicUrl) {
        throw new Error(`Tailscale ${mode} failed`);
      }

      return {
        publicUrl,
        provider: `tailscale-${mode}`,
        stop: async () => {
          for (const route of routes) {
            await cleanupTailscaleExposureRoute({
              mode,
              port: tailscalePort,
              path: route.path,
            });
          }
        },
      };
    }
    default:
      return null;
  }
}
