/**
 * Streaming CLI Runner
 *
 * Executes the Claude CLI with streaming output, parsing JSONL events
 * in real-time and forwarding tool status updates to callbacks.
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("agent/cli-streaming");

export type CliStreamEvent =
  | { type: "tool_start"; toolName: string; toolCallId: string }
  | { type: "tool_result"; toolCallId: string; isError: boolean }
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "result"; text: string; sessionId?: string; usage?: CliUsage }
  | { type: "error"; message: string };

export type CliUsage = {
  input_tokens?: number;
  output_tokens?: number;
};

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
      text?: string;
      thinking?: string;
    }>;
  };
  result?: string;
  session_id?: string;
  cost_usd?: number;
  is_error?: boolean;
  duration_ms?: number;
  duration_api_ms?: number;
  num_turns?: number;
  usage?: CliUsage;
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
}> {
  const { command, args, cwd, env, timeoutMs, onEvent } = options;

  return new Promise((resolve, reject) => {
    let resultText = "";
    let sessionId: string | undefined;
    let usage: CliUsage | undefined;
    let settled = false;

    const child = spawn(command, args, {
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
      if (!line.trim()) return;

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
            usage = event.usage;
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
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    child.on("close", (code) => {
      if (settled) return;
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
  if (!onEvent) return;

  // Handle different event types from Claude CLI stream-json format
  if (event.type === "assistant" && event.message?.content) {
    for (const block of event.message.content) {
      if (block.type === "tool_use" && block.name && block.id) {
        onEvent({
          type: "tool_start",
          toolName: block.name,
          toolCallId: block.id,
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
      if (block.type === "tool_result" && block.id) {
        onEvent({
          type: "tool_result",
          toolCallId: block.id,
          isError: false,
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
        usage: event.usage,
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
