// SoundChain Forge — Execution tools: bash, git, glob, grep
// Mirrors Claude Code's Bash, Glob, Grep semantics.

import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { resolve, join, relative } from "node:path";
import { createInterface } from "node:readline";
import { Type } from "@sinclair/typebox";
// Standalone type — no OpenClaw dependency needed at runtime
type AnyAgentTool = {
  name: string;
  label?: string;
  description?: string;
  parameters?: any;
  execute: (id: string, params: Record<string, unknown>) => Promise<any>;
};
import { PathGuard, BashGuard, GitGuard } from "./guards.js";

const MAX_OUTPUT = 30 * 1024; // 30 KB output cap

function json<T>(payload: T) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    details: payload,
  };
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n... (truncated at ${max} bytes)`;
}

// ─── Shell execution helper ──────────────────────────────────────────────

function execShell(
  command: string,
  opts: { cwd?: string; timeout?: number },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const timeout = Math.min(opts.timeout ?? 120_000, 600_000);
    let stdout = "";
    let stderr = "";
    let killed = false;

    const proc = spawn("/bin/bash", ["-c", command], {
      cwd: opts.cwd,
      timeout,
      env: { ...process.env, TERM: "dumb" },
    });

    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      if (stdout.length > MAX_OUTPUT * 2) {
        stdout = stdout.slice(0, MAX_OUTPUT);
        proc.kill("SIGTERM");
        killed = true;
      }
    });

    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.length > MAX_OUTPUT) {
        stderr = stderr.slice(0, MAX_OUTPUT);
      }
    });

    proc.on("close", (code) => {
      resolve({
        stdout: truncate(stdout, MAX_OUTPUT),
        stderr: truncate(stderr, MAX_OUTPUT),
        exitCode: killed ? 137 : (code ?? 1),
      });
    });

    proc.on("error", (err) => {
      resolve({
        stdout: "",
        stderr: `Process error: ${err.message}`,
        exitCode: 1,
      });
    });
  });
}

// ─── forge_bash ──────────────────────────────────────────────────────────

export function createBashTool(
  pathGuard: PathGuard,
  bashGuard: BashGuard,
  defaultCwd: string,
): AnyAgentTool {
  return {
    name: "forge_bash",
    label: "Forge Bash",
    description:
      "Execute a bash command. Output is captured (stdout + stderr). " +
      "Default timeout 120s, max 600s. Output truncated at 30KB.",
    parameters: Type.Object({
      command: Type.String({ description: "The bash command to execute" }),
      timeout: Type.Optional(
        Type.Number({
          description: "Timeout in milliseconds (default 120000, max 600000)",
          minimum: 1000,
          maximum: 600000,
        }),
      ),
      cwd: Type.Optional(Type.String({ description: "Working directory (defaults to repo root)" })),
    }),
    async execute(_id: string, params: Record<string, unknown>) {
      const command = typeof params.command === "string" ? params.command : "";
      const timeout = typeof params.timeout === "number" ? params.timeout : 120_000;
      const cwd = typeof params.cwd === "string" ? params.cwd : defaultCwd;

      if (!command.trim()) {
        return json({ error: "Command cannot be empty" });
      }

      const bashCheck = bashGuard.validate(command);
      if (bashCheck.verdict !== "ALLOWED") {
        return json({ error: bashCheck.error });
      }

      // Validate cwd if provided
      if (cwd !== defaultCwd) {
        const cwdCheck = pathGuard.validate(cwd);
        if (cwdCheck.verdict !== "ALLOWED") {
          return json({ error: `Working directory: ${cwdCheck.error}` });
        }
      }

      const result = await execShell(command, { cwd, timeout });
      return json(result);
    },
  } as AnyAgentTool;
}

// ─── forge_git ───────────────────────────────────────────────────────────

export function createGitTool(gitGuard: GitGuard, defaultCwd: string): AnyAgentTool {
  return {
    name: "forge_git",
    label: "Forge Git",
    description:
      "Run git operations safely. Blocks dangerous flags (--force, --hard, --no-verify). " +
      "Allowed subcommands: status, diff, log, add, commit, push, pull, branch, checkout, " +
      "stash, show, remote, fetch, merge, rebase, cherry-pick, tag, rev-parse, ls-files, blame.",
    parameters: Type.Object({
      command: Type.String({
        description: "Git subcommand (e.g. 'status', 'diff', 'log', 'add', 'commit')",
      }),
      args: Type.Optional(
        Type.Array(Type.String(), {
          description: "Arguments for the git command",
        }),
      ),
      cwd: Type.Optional(
        Type.String({ description: "Repository directory (defaults to repo root)" }),
      ),
    }),
    async execute(_id: string, params: Record<string, unknown>) {
      const subcommand = typeof params.command === "string" ? params.command.trim() : "";
      const args: string[] = Array.isArray(params.args)
        ? params.args.filter((a): a is string => typeof a === "string")
        : [];
      const cwd = typeof params.cwd === "string" ? params.cwd : defaultCwd;

      if (!subcommand) {
        return json({ error: "Git subcommand is required" });
      }

      const check = gitGuard.validate(subcommand, args);
      if (check.verdict !== "ALLOWED") {
        return json({ error: check.error });
      }

      const fullCmd = ["git", subcommand, ...args].join(" ");
      const result = await execShell(fullCmd, { cwd, timeout: 60_000 });
      return json(result);
    },
  } as AnyAgentTool;
}

// ─── forge_glob ──────────────────────────────────────────────────────────

export function createGlobTool(pathGuard: PathGuard, defaultCwd: string): AnyAgentTool {
  return {
    name: "forge_glob",
    label: "Forge Glob",
    description:
      "Find files by glob pattern (e.g. '**/*.ts', 'src/**/*.tsx'). " +
      "Ignores node_modules and .git. Results sorted by modification time (newest first).",
    parameters: Type.Object({
      pattern: Type.String({ description: "Glob pattern to match files" }),
      path: Type.Optional(
        Type.String({ description: "Directory to search in (defaults to repo root)" }),
      ),
    }),
    async execute(_id: string, params: Record<string, unknown>) {
      const pattern = typeof params.pattern === "string" ? params.pattern : "";
      const searchPath = typeof params.path === "string" ? params.path : defaultCwd;

      if (!pattern) {
        return json({ error: "Pattern is required" });
      }

      const pathCheck = pathGuard.validate(searchPath);
      if (pathCheck.verdict !== "ALLOWED") {
        return json({ error: pathCheck.error });
      }

      try {
        // Use fast-glob if available, fallback to find command
        let fg: typeof import("fast-glob") | null = null;
        try {
          fg = await import("fast-glob");
        } catch {
          // fast-glob not installed, use find fallback
        }

        if (fg) {
          const files = await fg.default(pattern, {
            cwd: pathCheck.resolved,
            ignore: ["**/node_modules/**", "**/.git/**"],
            absolute: true,
            stats: true,
            onlyFiles: true,
          });

          // Sort by mtime newest first
          const sorted = files
            .sort((a, b) => {
              const aTime = a.stats?.mtimeMs ?? 0;
              const bTime = b.stats?.mtimeMs ?? 0;
              return bTime - aTime;
            })
            .slice(0, 200);

          return json({
            pattern,
            path: pathCheck.resolved,
            count: files.length,
            showing: sorted.length,
            files: sorted.map((f) => f.path),
          });
        }

        // Fallback: use find command
        const result = await execShell(
          `find . -name '.git' -prune -o -name 'node_modules' -prune -o -name '${pattern.replace(/\*/g, "*")}' -type f -print | head -200`,
          { cwd: pathCheck.resolved, timeout: 15_000 },
        );

        const files = result.stdout
          .trim()
          .split("\n")
          .filter((f) => f.length > 0)
          .map((f) => resolve(pathCheck.resolved, f));

        return json({
          pattern,
          path: pathCheck.resolved,
          count: files.length,
          files,
        });
      } catch (err: any) {
        return json({ error: `Glob failed: ${err.message}` });
      }
    },
  } as AnyAgentTool;
}

// ─── forge_grep ──────────────────────────────────────────────────────────

export function createGrepTool(pathGuard: PathGuard, defaultCwd: string): AnyAgentTool {
  return {
    name: "forge_grep",
    label: "Forge Grep",
    description:
      "Search file contents by regex pattern. Uses ripgrep (rg) if available, " +
      "falls back to grep. Supports output modes: 'content' (matching lines), " +
      "'files' (file paths only), 'count' (match counts per file).",
    parameters: Type.Object({
      pattern: Type.String({ description: "Regex pattern to search for" }),
      path: Type.Optional(
        Type.String({ description: "File or directory to search (defaults to repo root)" }),
      ),
      glob: Type.Optional(
        Type.String({ description: "Glob filter for files (e.g. '*.ts', '*.tsx')" }),
      ),
      output_mode: Type.Optional(
        Type.Union([Type.Literal("content"), Type.Literal("files"), Type.Literal("count")], {
          description: "Output mode: content, files, or count (default: files)",
        }),
      ),
      context: Type.Optional(
        Type.Number({
          description: "Lines of context around matches (for content mode)",
          minimum: 0,
          maximum: 10,
        }),
      ),
      case_insensitive: Type.Optional(Type.Boolean({ description: "Case-insensitive search" })),
    }),
    async execute(_id: string, params: Record<string, unknown>) {
      const pattern = typeof params.pattern === "string" ? params.pattern : "";
      const searchPath = typeof params.path === "string" ? params.path : defaultCwd;
      const glob = typeof params.glob === "string" ? params.glob : "";
      const mode = typeof params.output_mode === "string" ? params.output_mode : "files";
      const context = typeof params.context === "number" ? params.context : 0;
      const caseInsensitive = params.case_insensitive === true;

      if (!pattern) {
        return json({ error: "Pattern is required" });
      }

      const pathCheck = pathGuard.validate(searchPath);
      if (pathCheck.verdict !== "ALLOWED") {
        return json({ error: pathCheck.error });
      }

      // Build rg command (try ripgrep first, fallback to grep)
      const args: string[] = [];

      // Output mode flags
      if (mode === "files") args.push("-l");
      else if (mode === "count") args.push("-c");
      else if (context > 0) args.push(`-C${context}`);

      if (caseInsensitive) args.push("-i");

      // Add line numbers for content mode
      if (mode === "content") args.push("-n");

      // Glob filter
      if (glob) args.push(`--glob=${glob}`);

      // Ignore patterns
      args.push("--glob=!node_modules", "--glob=!.git");

      // Max results
      if (mode === "content") args.push("--max-count=200");

      args.push("--", pattern, pathCheck.resolved);

      // Try ripgrep first
      let result = await execShell(`rg ${args.join(" ")}`, {
        cwd: pathCheck.resolved,
        timeout: 30_000,
      });

      // Fallback to grep if rg not found
      if (result.exitCode === 127 || result.stderr.includes("not found")) {
        const grepArgs: string[] = ["-r"];
        if (mode === "files") grepArgs.push("-l");
        else if (mode === "count") grepArgs.push("-c");
        else grepArgs.push("-n");
        if (caseInsensitive) grepArgs.push("-i");
        if (context > 0 && mode === "content") grepArgs.push(`-C${context}`);
        grepArgs.push("--exclude-dir=node_modules", "--exclude-dir=.git");
        if (glob) grepArgs.push(`--include=${glob}`);
        grepArgs.push("--", pattern, pathCheck.resolved);

        result = await execShell(`grep ${grepArgs.join(" ")}`, {
          cwd: pathCheck.resolved,
          timeout: 30_000,
        });
      }

      if (result.exitCode === 1 && !result.stdout.trim()) {
        return json({ pattern, matches: 0, output: "No matches found" });
      }

      const lines = result.stdout
        .trim()
        .split("\n")
        .filter((l) => l.length > 0);

      return json({
        pattern,
        mode,
        matches: lines.length,
        output: truncate(result.stdout, MAX_OUTPUT),
      });
    },
  } as AnyAgentTool;
}
