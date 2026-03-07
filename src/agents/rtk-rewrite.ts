import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { logInfo } from "../logger.js";

const execFileAsync = promisify(execFile);

let rtkAvailable: boolean | null = null;
let rtkDetectionPromise: Promise<boolean> | null = null;

/**
 * Trigger async rtk detection on first call. Result is cached for process lifetime.
 * Safe to call multiple times — detection runs only once.
 */
export function initRtkDetection(): void {
  if (rtkDetectionPromise) {
    return;
  }
  rtkDetectionPromise = detectRtk();
}

async function detectRtk(): Promise<boolean> {
  try {
    await execFileAsync("rtk", ["--version"], {
      timeout: 3000,
    });
    rtkAvailable = true;
    logInfo("exec: rtk detected — compact output enabled");
    return true;
  } catch {
    rtkAvailable = false;
    logInfo("exec: rtk not found — compact output disabled");
    return false;
  }
}

/**
 * Check if rtk is available. Non-blocking after initRtkDetection() has been called.
 */
async function isRtkAvailable(): Promise<boolean> {
  if (rtkAvailable !== null) {
    return rtkAvailable;
  }
  if (rtkDetectionPromise) {
    return rtkDetectionPromise;
  }
  initRtkDetection();
  return rtkDetectionPromise!;
}

/**
 * Attempt to rewrite a command via `rtk rewrite`. Returns the rewritten command
 * string if rtk can compress it, or null if no rewrite is needed / rtk unavailable.
 *
 * Must only be called AFTER all security checks have passed.
 */
export async function tryRtkRewrite(command: string): Promise<string | null> {
  if (!(await isRtkAvailable())) {
    return null;
  }

  try {
    const { stdout } = await execFileAsync("rtk", ["rewrite", command], {
      timeout: 2000,
    });
    const rewritten = stdout.trim();
    if (rewritten && rewritten !== command) {
      return rewritten;
    }
    return null;
  } catch {
    // Exit code 1 = no rewrite needed; other errors = skip silently
    return null;
  }
}

/** Reset cached detection state (for testing). */
export function resetRtkDetection(): void {
  rtkAvailable = null;
  rtkDetectionPromise = null;
}
