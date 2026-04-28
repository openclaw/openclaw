import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  PluginHookBeforeToolCallEvent,
  PluginHookBeforeToolCallResult,
  PluginHookToolContext,
  PluginLogger,
} from "openclaw/plugin-sdk/plugin-runtime";
import type { ForkGuardConfig } from "./config.js";

const execFileAsync = promisify(execFile);

export type GuardDeps = {
  execFile?: typeof execFileAsync;
};

export type AnalyzeExecToolCallParams = {
  event: PluginHookBeforeToolCallEvent;
  ctx: PluginHookToolContext;
  config: ForkGuardConfig;
  logger?: PluginLogger;
  deps?: GuardDeps;
};

type ParsedPattern =
  | { kind: "string"; raw: string; value: string }
  | { kind: "regex"; raw: string; value: RegExp };

type DiffHit = {
  file: string;
  line: number;
  excerpt: string;
  pattern: string;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function normalizeCwd(value: unknown): string | undefined {
  const cwd = getString(value)?.trim();
  return cwd && cwd.length > 0 ? cwd : undefined;
}

export function isProtectedCommand(command: string): boolean {
  return /(^|\s)(git\s+push|gh\s+pr\s+create)(\s|$)/.test(command);
}

export function parsePattern(raw: string): ParsedPattern {
  const regexLiteral = raw.match(/^\/(.*)\/([a-z]*)$/i);
  if (!regexLiteral) {
    return { kind: "string", raw, value: raw };
  }
  const [, pattern, flags] = regexLiteral;
  try {
    return { kind: "regex", raw, value: new RegExp(pattern, flags) };
  } catch {
    return { kind: "string", raw, value: raw };
  }
}

export async function runGit(
  cwd: string,
  args: string[],
  deps?: GuardDeps,
): Promise<{ stdout: string; stderr: string }> {
  const runner = deps?.execFile ?? execFileAsync;
  return await runner("git", args, { cwd, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
}

export async function resolveGitRemoteUrls(cwd: string, deps?: GuardDeps): Promise<string[]> {
  const remotes = (await runGit(cwd, ["remote"], deps)).stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const urls: string[] = [];
  for (const remote of remotes) {
    try {
      const url = (await runGit(cwd, ["remote", "get-url", remote], deps)).stdout.trim();
      if (url) {
        urls.push(url);
      }
    } catch {
      // Ignore individual remotes that fail to resolve.
    }
  }
  return urls;
}

export function matchesBlockedRepo(remoteUrls: string[], blockedRepos: string[]): boolean {
  return remoteUrls.some((url) => blockedRepos.some((needle) => url.includes(needle)));
}

export async function buildProtectedDiff(
  cwd: string,
  config: ForkGuardConfig,
  deps?: GuardDeps,
): Promise<string> {
  const baseRef = `${config.upstreamRemote}/${config.upstreamBranch}`;
  return (await runGit(cwd, ["diff", `${baseRef}..HEAD`, "--", "."], deps)).stdout;
}

export function findFirstDiffHit(diffText: string, rawPatterns: string[]): DiffHit | null {
  const patterns = rawPatterns.map(parsePattern);
  let currentFile = "<unknown>";
  let newLine = 0;

  for (const rawLine of diffText.split(/\r?\n/)) {
    if (rawLine.startsWith("+++ b/")) {
      currentFile = rawLine.slice("+++ b/".length);
      continue;
    }
    const hunk = rawLine.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (hunk) {
      newLine = Number.parseInt(hunk[1] ?? "0", 10);
      continue;
    }
    if (rawLine.startsWith("+") && !rawLine.startsWith("+++")) {
      const addedLine = rawLine.slice(1);
      for (const pattern of patterns) {
        const matched =
          pattern.kind === "string"
            ? addedLine.includes(pattern.value)
            : pattern.value.test(addedLine);
        if (matched) {
          return {
            file: currentFile,
            line: newLine,
            excerpt: addedLine,
            pattern: pattern.raw,
          };
        }
      }
      newLine += 1;
      continue;
    }
    if (!rawLine.startsWith("-")) {
      newLine += 1;
    }
  }

  return null;
}

export function formatBlockReason(hit: DiffHit): string {
  return `fork-guard blocked push/PR: matched ${hit.pattern} in ${hit.file}:${hit.line}`;
}

export async function analyzeExecToolCall({
  event,
  ctx,
  config,
  logger,
  deps,
}: AnalyzeExecToolCallParams): Promise<PluginHookBeforeToolCallResult | undefined> {
  const params = asRecord(event.params);
  const command = getString(params["command"]);
  const cwd = normalizeCwd(params["workdir"] ?? params["cwd"]);

  if (!command || !cwd || !isProtectedCommand(command)) {
    return undefined;
  }

  let remoteUrls: string[];
  try {
    remoteUrls = await resolveGitRemoteUrls(cwd, deps);
  } catch (error) {
    logger?.warn?.(
      `[fork-guard] could not inspect remotes for ${cwd}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }

  if (!matchesBlockedRepo(remoteUrls, config.blockedRepos)) {
    return undefined;
  }

  let diffText: string;
  try {
    diffText = await buildProtectedDiff(cwd, config, deps);
  } catch (error) {
    logger?.warn?.(
      `[fork-guard] could not compute diff for ${cwd}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }

  const hit = findFirstDiffHit(diffText, config.blocklist);
  if (!hit) {
    logger?.debug?.(`[fork-guard] clear diff for ${cwd} on ${ctx.toolName}`);
    return undefined;
  }

  return {
    block: true,
    blockReason: formatBlockReason(hit),
  };
}
