/**
 * WSL2 crash loop risk detection for Ollama.
 *
 * When Ollama is installed with `Restart=always` + `WantedBy=default.target`
 * on WSL2, it auto-starts at boot and pins physical RAM via cudaMallocHost.
 * The Hyper-V hv_balloon driver cannot reclaim pinned pages, so Windows
 * forcibly terminates the WSL2 VM — which then restarts, triggering the
 * same sequence in an infinite loop.
 *
 * See: https://github.com/ollama/ollama/issues/11317
 *
 * All checks are wrapped in try/catch — any failure silently skips the
 * warning and never breaks provider discovery.
 */

import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { promisify } from "node:util";
import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";

const execFileAsync = promisify(execFile);

/** Returns true when running inside WSL2 (not WSL1, not bare Linux). */
export async function isWsl2(): Promise<boolean> {
  try {
    const content = await readFile("/proc/version", "utf8");
    return /wsl2/i.test(content) || /microsoft-standard/i.test(content);
  } catch {
    return false;
  }
}

/**
 * Returns true when the ollama.service systemd unit is both:
 *   - enabled (will start on boot)
 *   - configured with Restart=always
 */
export async function isOllamaEnabledWithRestartAlways(): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      "systemctl",
      ["show", "ollama.service", "--property=UnitFileState,Restart", "--no-pager"],
      { timeout: 5000 },
    );
    return stdout.includes("UnitFileState=enabled") && stdout.includes("Restart=always");
  } catch {
    return false;
  }
}

/** Returns true when a CUDA installation is detected. */
export async function hasCuda(): Promise<boolean> {
  try {
    await access("/usr/lib/wsl/lib/nvidia-smi");
    return true;
  } catch {
    // fall through
  }
  try {
    await access("/usr/local/cuda");
    return true;
  } catch {
    // fall through
  }
  return false;
}

/**
 * Runs a single-shot WSL2 crash loop risk check and logs a warning if the
 * risky configuration is detected.
 *
 * Only call this in daemon context (`api.registrationMode === "full"`).
 * Never throws.
 */
export async function checkWsl2CrashLoopRisk(logger: PluginLogger): Promise<void> {
  try {
    const wsl2 = await isWsl2();
    if (!wsl2) return;

    const risky = await isOllamaEnabledWithRestartAlways();
    if (!risky) return;

    const cudaDetected = await hasCuda();
    const cudaNote = cudaDetected
      ? " CUDA installation detected — pinned RAM pages are likely."
      : "";

    logger.warn(
      [
        `[ollama] ⚠️  WSL2 crash loop risk: Ollama systemd service is enabled with Restart=always.${cudaNote}`,
        "",
        "On WSL2, Ollama auto-starts at boot and pins physical RAM via cudaMallocHost.",
        "The Hyper-V hv_balloon dynamic memory driver cannot reclaim pinned pages,",
        "so Windows forcibly terminates the WSL2 VM — which restarts and loops.",
        "",
        "Evidence: repeated WSL2 reboots, high CPU in app.slice at startup, SIGTERM from systemd.",
        "See: https://github.com/ollama/ollama/issues/11317",
        "",
        "Fix (apply all three):",
        "  1. sudo systemctl disable ollama",
        "  2. Add  autoMemoryReclaim=disabled  to %USERPROFILE%\\.wslconfig  (Windows-side)",
        "  3. Set  OLLAMA_KEEP_ALIVE=5m  in your Ollama environment",
      ].join("\n"),
    );
  } catch {
    // Never break provider discovery — checks are purely advisory.
  }
}
