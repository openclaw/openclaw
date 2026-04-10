/**
 * Streaming CLI Runner
 *
 * Executes the Claude CLI with streaming output, parsing JSONL events
 * in real-time and forwarding tool status updates to callbacks.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("agent/cli-streaming");

// On Windows, `spawn("claude", ...)` fails with ENOENT because the
// npm-generated shim is `claude.cmd`, and Node's spawn cannot execute
// .cmd/.bat files without a shell. `shell: true` is unsafe when user
// input is in argv (cmd.exe interprets &, |, >, etc.). We resolve the
// command via PATH, and if it's a .cmd/.bat we wrap the call through
// `cmd.exe /d /s /c` with windowsVerbatimArguments + manual escaping,
// matching cross-spawn's approach.
function resolveWindowsCommand(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): { command: string; args: string[]; extra: { windowsVerbatimArguments?: boolean } } {
  if (process.platform !== "win32") {
    return { command, args: [...args], extra: {} };
  }
  const resolved = findOnPath(command, env);
  if (!resolved) {
    return { command, args: [...args], extra: {} };
  }
  const ext = path.extname(resolved).toLowerCase();
  if (ext !== ".cmd" && ext !== ".bat") {
    return { command: resolved, args: [...args], extra: {} };
  }
  const escaped = [quoteForCmd(resolved), ...args.map(quoteForCmd)].join(" ");
  return {
    command: env.COMSPEC || "cmd.exe",
    args: ["/d", "/s", "/c", escaped],
    extra: { windowsVerbatimArguments: true },
  };
}

function findOnPath(command: string, env: NodeJS.ProcessEnv): string | undefined {
  if (path.isAbsolute(command) && existsSync(command)) {
    return command;
  }
  const dirs = (env.PATH || env.Path || "").split(path.delimiter).filter(Boolean);
  const exts = (env.PATHEXT || ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((e) => e.trim())
    .filter(Boolean);
  for (const dir of dirs) {
    for (const ext of ["", ...exts]) {
      const candidate = path.join(dir, command + ext);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

// Quote an argument for safe passage through `cmd.exe /c`. Wraps in
// double quotes and escapes embedded quotes + cmd.exe metacharacters.
function quoteForCmd(arg: string): string {
  // Escape backslashes that precede a double quote (Windows CRT rules),
  // then escape the quote itself.
  const quoted = '"' + arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1") + '"';
  // Escape cmd.exe metacharacters that would otherwise be interpreted
  // even inside quotes when the outer shell parses the command line.
  return quoted.replace(/([()%!^"<>&|])/g, "^$1");
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
    const child = spawn(resolved.command, resolved.args, {
      cwd,
      env: env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      ...resolved.extra,
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
      reject(err);
    });

    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);

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
