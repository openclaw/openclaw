import { spawn } from "node:child_process";
import {
  appendBoundedChildOutput,
  emptyBoundedChildOutput,
  formatBoundedChildOutput,
} from "./bounded-child-output.js";
import { getTailscaleDnsName } from "./webhook/tailscale.js";

const NGROK_LOG_BUFFER_MAX_CHARS = 16_384;

interface TunnelConfig {
  /** Tunnel provider: ngrok, tailscale-serve, tailscale-funnel, or none. */
  provider: "ngrok" | "tailscale-serve" | "tailscale-funnel" | "none";
  /** Local webhook server port to expose. */
  port: number;
  /** Webhook path appended to the provider-visible public origin. */
  path: string;
  /** Optional ngrok auth token, applied before the tunnel starts. */
  ngrokAuthToken?: string;
  /** Optional ngrok custom domain. */
  ngrokDomain?: string;
}

export interface TunnelResult {
  /** Provider-visible webhook URL, including the configured webhook path. */
  publicUrl: string;
  /** Idempotent cleanup hook for the spawned tunnel route/process. */
  stop: () => Promise<void>;
  /** Tunnel provider that produced this public URL. */
  provider: string;
}

/** Starts an ngrok CLI tunnel and returns the provider-visible webhook URL. */
export async function startNgrokTunnel(config: {
  /** Local webhook server port to expose through ngrok. */
  port: number;
  /** Webhook path appended to the ngrok public origin. */
  path: string;
  /** Optional ngrok auth token configured before startup. */
  authToken?: string;
  /** Optional ngrok custom domain. */
  domain?: string;
}): Promise<TunnelResult> {
  if (config.authToken) {
    await runNgrokCommand(["config", "add-authtoken", config.authToken]);
  }

  const args = ["http", String(config.port), "--log", "stdout", "--log-format", "json"];

  if (config.domain) {
    args.push("--domain", config.domain);
  }

  return new Promise((resolve, reject) => {
    const proc = spawn("ngrok", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let resolved = false;
    let publicUrl: string | null = null;
    let outputBuffer = "";

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        proc.kill("SIGTERM");
        reject(new Error("ngrok startup timed out (30s)"));
      }
    }, 30000);

    const processLine = (line: string) => {
      try {
        const log = JSON.parse(line);

        // The JSON log stream is the stable readiness signal; stdout prose can
        // vary across ngrok versions and should not drive URL discovery.
        if (log.msg === "started tunnel" && log.url) {
          publicUrl = log.url;
        }

        if (log.addr && log.url && !publicUrl) {
          publicUrl = log.url;
        }

        // Check for ready state
        if (publicUrl && !resolved) {
          resolved = true;
          clearTimeout(timeout);

          // Providers call the webhook path, not the bare ngrok origin.
          const fullUrl = publicUrl + config.path;

          console.log(`[voice-call] ngrok tunnel active: ${fullUrl}`);

          resolve({
            publicUrl: fullUrl,
            provider: "ngrok",
            stop: async () => {
              proc.kill("SIGTERM");
              await new Promise<void>((res) => {
                proc.on("close", () => res());
                setTimeout(res, 2000); // Fallback timeout
              });
            },
          });
        }
      } catch {
        // Ignore non-JSON startup text; stderr handles actionable CLI errors.
      }
    };

    proc.stdout.on("data", (data: Buffer) => {
      const lines = (outputBuffer + data.toString()).split("\n");
      outputBuffer = lines.pop() || "";
      if (outputBuffer.length > NGROK_LOG_BUFFER_MAX_CHARS) {
        outputBuffer = outputBuffer.slice(-NGROK_LOG_BUFFER_MAX_CHARS);
      }

      for (const line of lines) {
        if (line.trim()) {
          processLine(line);
        }
      }
    });

    proc.stderr.on("data", (data: Buffer) => {
      const msg = data.toString();
      if (msg.includes("ERR_NGROK")) {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          const output = appendBoundedChildOutput(emptyBoundedChildOutput(), msg);
          reject(new Error(`ngrok error: ${formatBoundedChildOutput(output)}`));
        }
      }
    });

    proc.on("error", (err) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        reject(new Error(`Failed to start ngrok: ${err.message}`));
      }
    });

    proc.on("close", (code) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        reject(new Error(`ngrok exited unexpectedly with code ${code}`));
      }
    });
  });
}

async function runNgrokCommand(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ngrok", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = emptyBoundedChildOutput();
    let stderr = emptyBoundedChildOutput();

    proc.stdout.on("data", (data) => {
      stdout = appendBoundedChildOutput(stdout, data.toString());
    });
    proc.stderr.on("data", (data) => {
      stderr = appendBoundedChildOutput(stderr, data.toString());
    });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve(stdout.text);
      } else {
        const output = stderr.text ? stderr : stdout;
        reject(new Error(`ngrok command failed: ${formatBoundedChildOutput(output)}`));
      }
    });

    proc.on("error", reject);
  });
}

/** Checks whether the ngrok CLI is installed without surfacing spawn failures to callers. */
export async function isNgrokAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn("ngrok", ["version"], {
      stdio: "ignore",
    });

    proc.on("close", (code) => {
      resolve(code === 0);
    });

    proc.on("error", () => {
      resolve(false);
    });
  });
}

/** Starts one Tailscale serve/funnel route for the configured webhook path. */
export async function startTailscaleTunnel(config: {
  /** Tailscale exposure mode; funnel is internet-public, serve is tailnet-scoped. */
  mode: "serve" | "funnel";
  /** Local webhook server port to expose. */
  port: number;
  /** Webhook path to expose on the tailnet DNS name. */
  path: string;
}): Promise<TunnelResult> {
  const dnsName = await getTailscaleDnsName();
  if (!dnsName) {
    throw new Error("Could not get Tailscale DNS name. Is Tailscale running?");
  }

  const path = config.path.startsWith("/") ? config.path : `/${config.path}`;
  const localUrl = `http://127.0.0.1:${config.port}${path}`;

  return new Promise((resolve, reject) => {
    const proc = spawn("tailscale", [config.mode, "--bg", "--yes", "--set-path", path, localUrl], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = emptyBoundedChildOutput();
    let stderr = emptyBoundedChildOutput();

    const timeout = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error(`Tailscale ${config.mode} timed out`));
    }, 10000);

    proc.stdout.on("data", (data) => {
      stdout = appendBoundedChildOutput(stdout, data.toString());
    });
    proc.stderr.on("data", (data) => {
      stderr = appendBoundedChildOutput(stderr, data.toString());
    });

    proc.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        const publicUrl = `https://${dnsName}${path}`;
        console.log(`[voice-call] Tailscale ${config.mode} active: ${publicUrl}`);

        resolve({
          publicUrl,
          provider: `tailscale-${config.mode}`,
          stop: async () => {
            await stopTailscaleTunnel(config.mode, path);
          },
        });
      } else {
        const output = stderr.text ? stderr : stdout;
        const detail = output.text ? `: ${formatBoundedChildOutput(output)}` : "";
        reject(new Error(`Tailscale ${config.mode} failed with code ${code}${detail}`));
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

async function stopTailscaleTunnel(mode: "serve" | "funnel", path: string): Promise<void> {
  return new Promise((resolve) => {
    const proc = spawn("tailscale", [mode, "off", path], {
      stdio: "ignore",
    });

    const timeout = setTimeout(() => {
      proc.kill("SIGKILL");
      resolve();
    }, 5000);

    proc.on("close", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

/** Dispatches the configured webhook exposure provider, returning null for disabled tunnels. */
export async function startTunnel(config: TunnelConfig): Promise<TunnelResult | null> {
  switch (config.provider) {
    case "ngrok":
      return startNgrokTunnel({
        port: config.port,
        path: config.path,
        authToken: config.ngrokAuthToken,
        domain: config.ngrokDomain,
      });

    case "tailscale-serve":
      return startTailscaleTunnel({
        mode: "serve",
        port: config.port,
        path: config.path,
      });

    case "tailscale-funnel":
      return startTailscaleTunnel({
        mode: "funnel",
        port: config.port,
        path: config.path,
      });

    default:
      return null;
  }
}
