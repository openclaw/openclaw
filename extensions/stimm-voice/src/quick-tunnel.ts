import { spawn, type ChildProcess } from "node:child_process";

export interface QuickTunnelInfo {
  /** Base public URL returned by cloudflared (e.g. https://abc.trycloudflare.com). */
  publicBaseUrl: string;
  /** Full voice URL (publicBaseUrl + web path). */
  voiceUrl: string;
}

interface QuickTunnelLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
}

export interface QuickTunnelRuntime {
  info: QuickTunnelInfo;
  stop: () => void;
  running: () => boolean;
}

const TRY_CLOUDFLARE_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/gi;

function normalizePath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) return "/voice";
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

export async function startQuickTunnel(params: {
  gatewayPort: number;
  webPath: string;
  logger: QuickTunnelLogger;
  timeoutMs?: number;
}): Promise<QuickTunnelRuntime | null> {
  const timeoutMs = params.timeoutMs ?? 20_000;
  const localUrl = `http://127.0.0.1:${params.gatewayPort}`;
  const webPath = normalizePath(params.webPath);

  let proc: ChildProcess;
  try {
    proc = spawn(
      "cloudflared",
      ["tunnel", "--url", localUrl, "--no-autoupdate", "--metrics", "127.0.0.1:0"],
      {
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  } catch {
    params.logger.error(
      "[stimm-voice] cloudflared binary not found. Install Cloudflare Tunnel (cloudflared).",
    );
    return null;
  }

  const parse = (text: string): string | null => {
    const matches = text.match(TRY_CLOUDFLARE_URL_RE);
    if (!matches || matches.length === 0) return null;
    return matches[0];
  };

  return await new Promise<QuickTunnelRuntime | null>((resolve) => {
    let settled = false;
    let stderrBuffer = "";
    let stdoutBuffer = "";

    const finish = (value: QuickTunnelRuntime | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    const maybeResolveFromText = (text: string) => {
      const base = parse(text);
      if (!base) return false;
      const info: QuickTunnelInfo = {
        publicBaseUrl: base,
        voiceUrl: `${base}${webPath}`,
      };
      params.logger.info(`[stimm-voice] 🌐 Quick tunnel ready: ${info.voiceUrl}`);
      finish({
        info,
        stop: () => {
          if (proc && !proc.killed) proc.kill("SIGTERM");
        },
        running: () => !proc.killed && proc.exitCode === null,
      });
      return true;
    };

    proc.on("error", () => {
      params.logger.error("[stimm-voice] Failed to start cloudflared process.");
      finish(null);
    });

    proc.stdout?.on("data", (chunk: Buffer) => {
      stdoutBuffer += chunk.toString();
      // Run detection on the accumulated buffer so URLs split across chunks are found.
      maybeResolveFromText(stdoutBuffer);
    });

    proc.stderr?.on("data", (chunk: Buffer) => {
      stderrBuffer += chunk.toString();
      maybeResolveFromText(stderrBuffer);
    });

    proc.on("close", (code) => {
      if (settled) return;
      params.logger.warn(`[stimm-voice] cloudflared exited before URL was ready (code=${code}).`);
      finish(null);
    });

    const timer = setTimeout(() => {
      if (settled) return;
      const tail = `${stderrBuffer}\n${stdoutBuffer}`.trim().slice(-300);
      params.logger.error(`[stimm-voice] Timeout while starting cloudflared quick tunnel. ${tail}`);
      if (!proc.killed) proc.kill("SIGKILL");
      finish(null);
    }, timeoutMs);
  });
}
