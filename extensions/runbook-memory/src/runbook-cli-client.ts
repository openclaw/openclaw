import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { jsonResult } from "openclaw/plugin-sdk/browser-support";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";

export type RunbookCliAction = "search" | "get" | "create" | "update" | "review_queue" | "reindex";

export type RunbookMemoryPluginConfig = {
  pythonPath?: string;
  cliPath?: string;
  workspaceRoot?: string;
  dbPath?: string;
  runbooksRoot?: string;
};

export type RunbookCliRuntimePaths = {
  extensionRoot: string;
  repoRoot: string;
  cliPath: string;
  pythonPath: string;
  workspaceRoot: string;
  dbPath: string;
  runbooksRoot: string;
  timeoutMs: number;
  maxStdoutBytes: number;
};

export type RunbookCliPayload = {
  action: RunbookCliAction;
  params: Record<string, unknown>;
  runtime: {
    repoRoot: string;
    extensionRoot: string;
    workspaceRoot: string;
    dbPath: string;
    runbooksRoot: string;
  };
};

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_STDOUT_BYTES = 1_048_576;

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function expandHome(input: string): string {
  if (input === "~") {
    return os.homedir();
  }
  if (input.startsWith("~/")) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

function resolveMaybeRelativePath(raw: string | undefined, baseDir: string): string | undefined {
  const value = normalizeText(raw);
  if (!value) {
    return undefined;
  }
  const expanded = expandHome(value);
  return path.isAbsolute(expanded) ? expanded : path.resolve(baseDir, expanded);
}

function parsePluginConfig(api: OpenClawPluginApi): RunbookMemoryPluginConfig {
  const raw = api.pluginConfig ?? {};
  return {
    pythonPath: normalizeText(raw.pythonPath) || undefined,
    cliPath: normalizeText(raw.cliPath) || undefined,
    workspaceRoot: normalizeText(raw.workspaceRoot) || undefined,
    dbPath: normalizeText(raw.dbPath) || undefined,
    runbooksRoot: normalizeText(raw.runbooksRoot) || undefined,
  };
}

export function resolveRunbookPluginRoots(api: OpenClawPluginApi): RunbookCliRuntimePaths {
  const extensionRoot =
    normalizeText(api.rootDir) || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const repoRoot = path.resolve(extensionRoot, "..", "..");
  const pluginConfig = parsePluginConfig(api);
  const cliPath =
    resolveMaybeRelativePath(pluginConfig.cliPath, repoRoot) ??
    path.resolve(repoRoot, "runbook_memory", "tools", "runbook_cli.py");
  const pythonPath = normalizeText(pluginConfig.pythonPath) || "python3";
  const workspaceRoot = resolveMaybeRelativePath(pluginConfig.workspaceRoot, repoRoot) ?? repoRoot;
  const dbPath =
    resolveMaybeRelativePath(pluginConfig.dbPath, repoRoot) ??
    path.resolve(repoRoot, "runbook_memory", "db", "runbook_memory.sqlite3");
  const runbooksRoot =
    resolveMaybeRelativePath(pluginConfig.runbooksRoot, repoRoot) ??
    path.resolve(repoRoot, "runbooks");

  return {
    extensionRoot,
    repoRoot,
    cliPath,
    pythonPath,
    workspaceRoot,
    dbPath,
    runbooksRoot,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    maxStdoutBytes: DEFAULT_MAX_STDOUT_BYTES,
  };
}

export function buildRunbookCliPayload(
  api: OpenClawPluginApi,
  action: RunbookCliAction,
  params: Record<string, unknown>,
): RunbookCliPayload {
  const roots = resolveRunbookPluginRoots(api);
  return {
    action,
    params,
    runtime: {
      repoRoot: roots.repoRoot,
      extensionRoot: roots.extensionRoot,
      workspaceRoot: roots.workspaceRoot,
      dbPath: roots.dbPath,
      runbooksRoot: roots.runbooksRoot,
    },
  };
}

export function parseRunbookCliJson(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new Error("runbook CLI returned no JSON");
  }

  const parse = (input: string): unknown => {
    try {
      return JSON.parse(input) as unknown;
    } catch {
      return undefined;
    }
  };

  let parsed = parse(trimmed);
  if (parsed === undefined) {
    const suffixMatch = trimmed.match(/({[\s\S]*}|\[[\s\S]*])\s*$/);
    if (suffixMatch?.[1]) {
      parsed = parse(suffixMatch[1]);
    }
  }

  if (parsed === undefined) {
    throw new Error("runbook CLI returned invalid JSON");
  }

  return parsed;
}

async function runSubprocess(params: {
  pythonPath: string;
  cliPath: string;
  payload: RunbookCliPayload;
  cwd: string;
  timeoutMs: number;
  maxStdoutBytes: number;
}): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  const timeoutMs = Math.max(200, Math.trunc(params.timeoutMs));
  const maxStdoutBytes = Math.max(1024, Math.trunc(params.maxStdoutBytes));
  const env = {
    ...process.env,
    PYTHONUNBUFFERED: "1",
  } as NodeJS.ProcessEnv;
  const child = spawn(
    params.pythonPath,
    [
      params.cliPath,
      "--action",
      params.payload.action,
      "--payload-json",
      JSON.stringify(params.payload),
    ],
    {
      cwd: params.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env,
    },
  );

  let stdout = "";
  let stderr = "";
  let stdoutBytes = 0;
  let settled = false;

  return await new Promise<{ stdout: string; stderr: string; exitCode: number | null }>(
    (resolve, reject) => {
      const timer = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        child.kill("SIGKILL");
        reject(new Error(`runbook CLI timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      const settle = (
        result:
          | {
              ok: true;
              value: { stdout: string; stderr: string; exitCode: number | null };
            }
          | { ok: false; error: Error },
      ) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        if (result.ok) {
          resolve(result.value);
        } else {
          reject(result.error);
        }
      };

      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");

      child.stdout?.on("data", (chunk) => {
        const text = String(chunk);
        stdoutBytes += Buffer.byteLength(text, "utf8");
        if (stdoutBytes > maxStdoutBytes) {
          settle({ ok: false, error: new Error("runbook CLI exceeded stdout budget") });
          child.kill("SIGKILL");
          return;
        }
        stdout += text;
      });

      child.stderr?.on("data", (chunk) => {
        stderr += String(chunk);
      });

      child.once("error", (error) => {
        settle({
          ok: false,
          error: error instanceof Error ? error : new Error(String(error)),
        });
      });

      child.once("exit", (code) => {
        settle({ ok: true, value: { stdout, stderr, exitCode: code } });
      });
    },
  );
}

export async function executeRunbookCliTool(
  api: OpenClawPluginApi,
  action: RunbookCliAction,
  params: Record<string, unknown>,
) {
  const roots = resolveRunbookPluginRoots(api);
  if (!fs.existsSync(roots.cliPath)) {
    throw new Error(`runbook CLI not found: ${roots.cliPath}`);
  }

  const payload = buildRunbookCliPayload(api, action, params);
  const result = await runSubprocess({
    pythonPath: roots.pythonPath,
    cliPath: roots.cliPath,
    payload,
    cwd: roots.repoRoot,
    timeoutMs: roots.timeoutMs,
    maxStdoutBytes: roots.maxStdoutBytes,
  });

  const parsed = parseRunbookCliJson(result.stdout);
  const normalized =
    parsed && typeof parsed === "object"
      ? {
          ...parsed,
          _meta: {
            ...((parsed as Record<string, unknown>)._meta as Record<string, unknown> | undefined),
            exitCode: result.exitCode,
            stderr: result.stderr.trim() || undefined,
          },
        }
      : parsed;

  return jsonResult(normalized);
}
