/**
 * Streaming CLI Runner
 *
 * Executes the Claude CLI with streaming output, parsing JSONL events
 * in real-time and forwarding tool status updates to callbacks.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("agent/cli-streaming");

// On Windows, `spawn("claude", ...)` fails with ENOENT because the
// npm-generated shim is `claude.cmd`, which Node's spawn cannot execute
// without a shell. Routing through `cmd.exe /c` works for short command
// lines but hits cmd.exe's 8191-character limit ("The command line is
// too long") as soon as we pass a large system prompt as an argv element.
//
// Instead, we parse the npm shim to find the Node entry point it
// ultimately calls (e.g. `node_modules\@anthropic-ai\claude-code\cli.js`)
// and invoke `node.exe` directly with that script. CreateProcess's
// 32767-char limit is much larger, there is no shell escaping surface,
// and no cmd.exe involved at all.
function resolveWindowsCommand(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): { command: string; args: string[] } {
  if (process.platform !== "win32") {
    return { command, args: [...args] };
  }
  const resolved = findOnPath(command, env);
  if (!resolved) {
    return { command, args: [...args] };
  }
  const ext = path.extname(resolved).toLowerCase();
  if (ext !== ".cmd" && ext !== ".bat") {
    return { command: resolved, args: [...args] };
  }
  const nodeEntry = extractNpmShimEntry(resolved);
  if (!nodeEntry) {
    // Unknown shim format; leave it for the spawn call to fail loudly
    // rather than silently routing through cmd.exe with its length limit.
    return { command: resolved, args: [...args] };
  }
  return {
    command: nodeEntry.nodeExe,
    args: [nodeEntry.scriptPath, ...args],
  };
}

function findOnPath(command: string, env: NodeJS.ProcessEnv): string | undefined {
  if (path.isAbsolute(command) && existsSync(command)) {
    return command;
  }
  const dirs = (env.PATH || env.Path || "").split(path.delimiter).filter(Boolean);
  const pathext = (env.PATHEXT || ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((e) => e.trim())
    .filter(Boolean);
  // If the command already has a Windows executable extension, try it as-is.
  // Otherwise try each PATHEXT extension in order; never try the extensionless
  // name on Windows, since npm also installs Unix shell wrappers (e.g.
  // `claude` alongside `claude.cmd`) that Windows cannot execute directly.
  const ext = path.extname(command).toLowerCase();
  const candidates = ext && pathext.some((e) => e.toLowerCase() === ext) ? [""] : pathext;
  for (const dir of dirs) {
    for (const suffix of candidates) {
      const candidate = path.join(dir, command + suffix);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

// Windows CreateProcess has a 32767-character command line limit.
// OpenClaw passes the full system prompt (bootstrap files, tool defs,
// conversation history) as an argv element to `--system-prompt`, which
// routinely exceeds that limit and fails with `spawn ENAMETOOLONG`.
//
// Claude Code accepts `--system-prompt-file <path>` as an alternative
// that reads the prompt from a file, keeping argv small. On Windows,
// if we spot a `--system-prompt <value>` pair in the args where the
// value is large, we write the value to a temp file and swap in the
// file variant. Returns a cleanup callback that deletes the temp file
// once the spawned process exits.
const SYSTEM_PROMPT_FILE_THRESHOLD = 4000;

function materializeLongSystemPromptToFile(args: readonly string[]): {
  args: string[];
  cleanup: () => void;
} {
  const noop = () => {};
  if (process.platform !== "win32") {
    return { args: [...args], cleanup: noop };
  }
  const idx = args.findIndex((a) => a === "--system-prompt");
  if (idx === -1 || idx + 1 >= args.length) {
    return { args: [...args], cleanup: noop };
  }
  const value = args[idx + 1];
  if (value.length < SYSTEM_PROMPT_FILE_THRESHOLD) {
    return { args: [...args], cleanup: noop };
  }
  const tempPath = path.join(
    os.tmpdir(),
    `openclaw-system-prompt-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.txt`,
  );
  try {
    writeFileSync(tempPath, value, "utf8");
  } catch (err) {
    log.warn(
      `Failed to write system prompt to temp file ${tempPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { args: [...args], cleanup: noop };
  }
  const rewritten = [...args];
  rewritten[idx] = "--system-prompt-file";
  rewritten[idx + 1] = tempPath;
  const cleanup = () => {
    try {
      unlinkSync(tempPath);
    } catch {
      // ignore — temp file cleanup is best-effort
    }
  };
  return { args: rewritten, cleanup };
}

// Parse an npm-generated .cmd shim to find the JS entry point and the
// node.exe to run it with. The canonical shim format, e.g. from
// `npm install -g @anthropic-ai/claude-code`, contains a line like:
//
//   ... "%_prog%"  "%dp0%\node_modules\@anthropic-ai\claude-code\cli.js" %*
//
// where `%dp0%` is the directory of the shim itself, and `_prog` is
// either `%dp0%\node.exe` (if bundled) or `node` (resolved via PATH).
function extractNpmShimEntry(
  shimPath: string,
): { nodeExe: string; scriptPath: string } | undefined {
  let contents: string;
  try {
    contents = readFileSync(shimPath, "utf8");
  } catch {
    return undefined;
  }
  // Match a quoted path ending in .js/.mjs/.cjs that uses %dp0% or %~dp0%
  // as a prefix. This is how npm-generated shims reference their entry
  // point; we don't want to match arbitrary strings in an unrelated .cmd.
  const match = contents.match(/"%~?dp0%\\([^"]+\.(?:js|mjs|cjs))"/i);
  if (!match) {
    return undefined;
  }
  const shimDir = path.dirname(shimPath);
  const scriptPath = path.join(shimDir, match[1]);
  if (!existsSync(scriptPath)) {
    return undefined;
  }
  // Prefer a bundled node.exe next to the shim if present, otherwise
  // fall back to whichever `node` is currently running this gateway.
  const bundledNode = path.join(shimDir, "node.exe");
  const nodeExe = existsSync(bundledNode) ? bundledNode : process.execPath;
  return { nodeExe, scriptPath };
}

/**
 * Strip CLI line number prefixes from tool output.
 * The Read tool adds prefixes like "     1→" to each line.
 */
function stripCliLineNumbers(text: string): string {
  return text.replace(/^ *\d+→/gm, "");
}

/** Usage in the format expected by the rest of the codebase. */
export type CliUsage = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
};

/** Raw usage format from Claude CLI stream-json output. */
type RawCliUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
};

/** Convert raw CLI usage to our expected format. */
function convertUsage(raw?: RawCliUsage): CliUsage | undefined {
  if (!raw) {
    return undefined;
  }
  const input = raw.input_tokens;
  const output = raw.output_tokens;
  const cacheRead = raw.cache_read_input_tokens;
  const cacheWrite = raw.cache_creation_input_tokens;
  const total = (input ?? 0) + (output ?? 0);
  return { input, output, cacheRead, cacheWrite, total: total || undefined };
}

export type CliStreamEvent =
  | { type: "tool_start"; toolName: string; toolCallId: string; input?: Record<string, unknown> }
  | {
      type: "tool_result";
      toolCallId: string;
      isError: boolean;
      outputPreview?: string;
      lineCount?: number;
    }
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "result"; text: string; sessionId?: string; usage?: CliUsage }
  | { type: "error"; message: string };

export type StreamingCliOptions = {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  onEvent?: (event: CliStreamEvent) => void;
};

type StreamJsonMessage = {
  type?: string;
  subtype?: string;
  message?: {
    content?: Array<{
      type?: string;
      name?: string;
      id?: string;
      tool_use_id?: string;
      input?: Record<string, unknown>;
      text?: string;
      thinking?: string;
      // tool_result blocks carry output as a string or nested
      // content array, plus an optional error flag.
      content?: string | Array<{ type?: string; text?: string }>;
      is_error?: boolean;
    }>;
  };
  result?: string;
  session_id?: string;
  cost_usd?: number;
  is_error?: boolean;
  duration_ms?: number;
  duration_api_ms?: number;
  num_turns?: number;
  usage?: RawCliUsage;
};

/**
 * Run CLI command with streaming output parsing.
 * Returns the final result text and session ID.
 */
export async function runStreamingCli(options: StreamingCliOptions): Promise<{
  text: string;
  sessionId?: string;
  usage?: CliUsage;
  exitCode: number | null;
  stderr?: string;
}> {
  const { command, args, cwd, env, timeoutMs, onEvent } = options;

  return new Promise((resolve, reject) => {
    let resultText = "";
    let sessionId: string | undefined;
    let usage: CliUsage | undefined;
    let settled = false;

    const resolved = resolveWindowsCommand(command, args, env ?? process.env);
    const prepped = materializeLongSystemPromptToFile(resolved.args);
    const child = spawn(resolved.command, prepped.args, {
      cwd,
      env: env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const timer = setTimeout(() => {
      if (!settled) {
        log.warn("CLI streaming timeout, killing process");
        child.kill("SIGKILL");
      }
    }, timeoutMs);

    // Parse stdout line by line (JSONL format)
    const rl = createInterface({ input: child.stdout });

    rl.on("line", (line) => {
      if (!line.trim()) {
        return;
      }

      try {
        const event = JSON.parse(line) as StreamJsonMessage;
        processStreamEvent(event, onEvent, (text) => {
          resultText = text;
        });

        // Capture session ID and usage from result
        if (event.type === "result") {
          if (event.session_id) {
            sessionId = event.session_id;
          }
          if (event.result) {
            resultText = event.result;
          }
          if (event.usage) {
            usage = convertUsage(event.usage);
          }
        }
      } catch {
        // Not JSON, might be plain text output
        log.debug(`Non-JSON line: ${line.slice(0, 100)}`);
      }
    });

    // Capture stderr for error reporting
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (err) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      prepped.cleanup();
      reject(err);
    });

    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      prepped.cleanup();

      if (code !== 0 && !resultText) {
        onEvent?.({ type: "error", message: stderr || `CLI exited with code ${code}` });
      }

      resolve({
        text: resultText,
        sessionId,
        usage,
        exitCode: code,
        stderr: stderr || undefined,
      });
    });

    // Close stdin immediately (we pass prompt via args)
    child.stdin.end();
  });
}

function processStreamEvent(
  event: StreamJsonMessage,
  onEvent: ((event: CliStreamEvent) => void) | undefined,
  setResult: (text: string) => void,
): void {
  if (!onEvent) {
    return;
  }

  // Handle different event types from Claude CLI stream-json format
  if (event.type === "assistant" && event.message?.content) {
    for (const block of event.message.content) {
      if (block.type === "tool_use" && block.name && block.id) {
        onEvent({
          type: "tool_start",
          toolName: block.name,
          toolCallId: block.id,
          input: block.input,
        });
      } else if (block.type === "text" && block.text) {
        onEvent({ type: "text", text: block.text });
      } else if (block.type === "thinking" && block.thinking) {
        onEvent({ type: "thinking", text: block.thinking });
      }
    }
  }

  if (event.type === "user" && event.message?.content) {
    for (const block of event.message.content) {
      // tool_result blocks use tool_use_id (API format) or id
      const toolResultId =
        block.type === "tool_result"
          ? ((block as Record<string, unknown>).tool_use_id ?? block.id)
          : undefined;
      if (block.type === "tool_result" && typeof toolResultId === "string") {
        // Extract output text from the tool result content.
        // Content can be a plain string or an array of text
        // blocks (Claude API format).
        let outputText: string | undefined;
        if (typeof block.content === "string") {
          // Strip CLI line number prefixes (e.g. "     1→")
          // that the Read tool adds to file content.
          outputText = stripCliLineNumbers(block.content).trim() || undefined;
        } else if (Array.isArray(block.content)) {
          const texts = block.content
            .filter((b) => b.type === "text" && typeof b.text === "string")
            .map((b) => b.text!.trim())
            .filter(Boolean);
          outputText = texts.length > 0 ? texts.join("\n") : undefined;
        }

        const MAX_PREVIEW = 10;
        const lineCount = outputText ? outputText.split("\n").length : 0;
        const outputPreview =
          outputText && lineCount > 0
            ? outputText.split("\n").slice(0, MAX_PREVIEW).join("\n")
            : undefined;

        onEvent({
          type: "tool_result",
          toolCallId: toolResultId,
          isError: Boolean(block.is_error),
          outputPreview,
          lineCount,
        });
      }
    }
  }

  if (event.type === "result") {
    if (event.result) {
      setResult(event.result);
      onEvent({
        type: "result",
        text: event.result,
        sessionId: event.session_id,
        usage: convertUsage(event.usage),
      });
    }
  }
}

/**
 * Format tool name for display (similar to embedded runner).
 */
export function formatToolStatusLabel(toolName: string): string {
  const labels: Record<string, string> = {
    Bash: "Running a command",
    bash: "Running a command",
    exec: "Running a command",
    Read: "Reading a file",
    read_file: "Reading a file",
    Write: "Writing a file",
    write_file: "Writing a file",
    Edit: "Editing a file",
    Glob: "Searching files",
    Grep: "Searching code",
    WebSearch: "Searching the web",
    web_search: "Searching the web",
    WebFetch: "Fetching a webpage",
    Task: "Running a subagent",
    NotebookEdit: "Editing notebook",
  };

  return (
    labels[toolName] ??
    `Using ${toolName
      .replace(/([A-Z])/g, " $1")
      .trim()
      .toLowerCase()}`
  );
}
