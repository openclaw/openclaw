/**
 * Provider preScript executor.
 *
 * Runs a user-configured script before auth resolution to dynamically
 * provide apiKey/baseUrl via environment variable injection.
 *
 * Typical use case: an SSO/OAuth CLI that prints a JSON object with
 * short-lived tokens or endpoint URLs. The output keys are merged into
 * the process environment so `${VAR}` placeholders in provider config
 * resolve to the script-provided values.
 */

import { spawn, spawnSync } from "node:child_process";
import type { PreScriptConfig } from "../config/types.models.js";

const DEFAULT_TIMEOUT_MS = 30_000;

export type PreScriptResult = Record<string, string>;

export async function executeProviderPreScript(
  config: PreScriptConfig,
  fallbackCwd?: string,
): Promise<PreScriptResult> {
  const { command, args, cwd, timeoutMs } = normalizePreScriptConfig(config);
  const resolvedCwd = cwd ?? fallbackCwd ?? process.cwd();
  const timeout = timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise<PreScriptResult>((resolve) => {
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];

    const child = spawn(command, args, {
      cwd: resolvedCwd,
      stdio: ["ignore", "pipe", "pipe"],
      timeout,
      env: { ...process.env },
    });

    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => errChunks.push(chunk));

    child.on("error", (err) => {
      console.warn(`[preScript] spawn error for "${command}": ${err.message}`);
      resolve({});
    });

    child.on("close", (code) => {
      if (code !== 0) {
        const stderr = Buffer.concat(errChunks).toString().trim();
        console.warn(
          `[preScript] "${command}" exited with code ${code}${stderr ? `: ${stderr}` : ""}`,
        );
        resolve({});
        return;
      }

      const stdout = Buffer.concat(chunks).toString().trim();
      if (!stdout) {
        resolve({});
        return;
      }

      try {
        const parsed = JSON.parse(stdout);
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          const result: PreScriptResult = {};
          for (const [key, value] of Object.entries(parsed)) {
            if (typeof value === "string") {
              result[key] = value;
            }
          }
          resolve(result);
        } else {
          console.warn("[preScript] stdout is not a JSON object, ignoring");
          resolve({});
        }
      } catch {
        console.warn("[preScript] failed to parse stdout as JSON, ignoring");
        resolve({});
      }
    });
  });
}

/**
 * Synchronous version of executeProviderPreScript.
 * Used during config loading where async is not available.
 */
export function executeProviderPreScriptSync(
  config: PreScriptConfig,
  fallbackCwd?: string,
): PreScriptResult {
  const { command, args, cwd, timeoutMs } = normalizePreScriptConfig(config);
  const resolvedCwd = cwd ?? fallbackCwd ?? process.cwd();
  const timeout = timeoutMs ?? DEFAULT_TIMEOUT_MS;

  try {
    const result = spawnSync(command, args, {
      cwd: resolvedCwd,
      stdio: ["ignore", "pipe", "pipe"],
      timeout,
      env: { ...process.env },
    });

    if (result.error) {
      console.warn(`[preScript] spawn error for "${command}": ${result.error.message}`);
      return {};
    }

    if (result.status !== 0) {
      const stderr = result.stderr?.toString().trim() ?? "";
      console.warn(
        `[preScript] "${command}" exited with code ${result.status}${stderr ? `: ${stderr}` : ""}`,
      );
      return {};
    }

    const stdout = result.stdout?.toString().trim() ?? "";
    if (!stdout) {
      return {};
    }

    const parsed = JSON.parse(stdout);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      const out: PreScriptResult = {};
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === "string") {
          out[key] = value;
        }
      }
      return out;
    }
    console.warn("[preScript] stdout is not a JSON object, ignoring");
    return {};
  } catch {
    console.warn("[preScript] failed to parse stdout as JSON, ignoring");
    return {};
  }
}

function normalizePreScriptConfig(config: PreScriptConfig): {
  command: string;
  args: string[];
  cwd?: string;
  timeoutMs?: number;
} {
  if (typeof config === "string") {
    const parts = config.split(/\s+/);
    return { command: parts[0], args: parts.slice(1) };
  }
  return {
    command: config.command,
    args: config.args ?? [],
    cwd: config.cwd,
    timeoutMs: config.timeoutMs,
  };
}
