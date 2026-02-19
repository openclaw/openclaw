/**
 * Remote Agent Runner
 *
 * Forwards agent messages to an external HTTP SSE service (e.g. knowledge-agent).
 * The remote service receives the message + auth context via POST, processes it,
 * and streams SSE events back. This runner translates those events into the
 * OpenClaw agent event system so the TUI/UI/gateway sees them identically to
 * a local agent run.
 *
 * Event translation (Remote SSE → OpenClaw):
 *   chunk       → stream: "assistant",  data: { text }
 *   tool_call   → stream: "tool",       data: { phase: "start",  name, toolCallId, input }
 *   tool_result → stream: "tool",       data: { phase: "result", name, toolCallId, result }
 *   complete    → (return with accumulated text)
 *   error       → stream: "error",      data: { message }
 */

import { emitAgentEvent } from "../infra/agent-events.js";
import type { EmbeddedPiRunResult } from "./pi-embedded-runner/types.js";

export type RemoteAgentConfig = {
  url: string;
  transport?: "sse";
  secret?: string;
  timeoutMs?: number;
  healthUrl?: string;
};

export type RemoteAgentContext = {
  jwt?: string;
  org_id?: string;
  org_alias?: string;
  user_id?: string;
  thinking_level?: string;
};

type RemoteRunnerParams = {
  runId: string;
  sessionKey?: string;
  sessionAgentId: string;
  body: string;
  remote: RemoteAgentConfig;
  authContext?: RemoteAgentContext;
  history?: Array<{ role: string; content: string }>;
  onAgentEvent: (evt: { stream: string; data?: Record<string, unknown> }) => void;
};

/**
 * Parses an SSE stream from a ReadableStream<Uint8Array>.
 * Yields parsed { event, data } objects.
 */
async function* parseSseStream(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<{ event: string; data: unknown }> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      let currentEvent = "message";
      let currentData = "";

      for (const line of lines) {
        if (line.startsWith("event:")) {
          currentEvent = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          currentData = line.slice(5).trim();
        } else if (line === "") {
          // Blank line = end of event block
          if (currentData) {
            try {
              yield { event: currentEvent, data: JSON.parse(currentData) };
            } catch {
              yield { event: currentEvent, data: currentData };
            }
          }
          currentEvent = "message";
          currentData = "";
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export async function runRemoteAgent(params: RemoteRunnerParams): Promise<EmbeddedPiRunResult> {
  const startedAt = Date.now();
  const {
    runId,
    sessionKey,
    sessionAgentId,
    body,
    remote,
    authContext,
    history = [],
    onAgentEvent,
  } = params;

  const timeoutMs = remote.timeoutMs ?? 120_000;

  const requestBody = {
    message: body,
    session_key: sessionKey ?? `agent:${sessionAgentId}:main`,
    run_id: runId,
    context: {
      jwt: authContext?.jwt ?? "",
      org_id: authContext?.org_id ?? "",
      org_alias: authContext?.org_alias ?? "",
      user_id: authContext?.user_id ?? "",
      thinking_level: authContext?.thinking_level ?? "low",
    },
    history,
  };

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
  };
  if (remote.secret) {
    headers["Authorization"] = `Bearer ${remote.secret}`;
  }

  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

  let accumulatedText = "";
  // toolCallId → tool name, for result events that carry only the id
  const toolCallNames = new Map<string, string>();

  try {
    const response = await fetch(remote.url, {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => `HTTP ${response.status}`);
      throw new Error(`Remote agent error ${response.status}: ${errorText}`);
    }

    if (!response.body) {
      throw new Error("Remote agent returned empty response body");
    }

    for await (const { event, data } of parseSseStream(response.body)) {
      const d = data as Record<string, unknown>;

      switch (event) {
        case "start": {
          // Remote agent acknowledged the run — emit lifecycle start
          emitAgentEvent({
            runId,
            sessionKey,
            stream: "lifecycle",
            data: { phase: "start", agentId: d.agent ?? sessionAgentId },
          });
          onAgentEvent({ stream: "lifecycle", data: { phase: "start" } });
          break;
        }

        case "chunk": {
          const text = typeof d.text === "string" ? d.text : "";
          accumulatedText += text;
          emitAgentEvent({
            runId,
            sessionKey,
            stream: "assistant",
            data: { text },
          });
          break;
        }

        case "tool_call": {
          const name = typeof d.name === "string" ? d.name : "unknown";
          const toolCallId =
            typeof d.tool_call_id === "string" ? d.tool_call_id : `tc-${Date.now()}`;
          toolCallNames.set(toolCallId, name);
          emitAgentEvent({
            runId,
            sessionKey,
            stream: "tool",
            data: {
              phase: "start",
              name,
              toolCallId,
              input: d.input ?? {},
            },
          });
          onAgentEvent({
            stream: "tool",
            data: { phase: "start", name, toolCallId },
          });
          break;
        }

        case "tool_result": {
          const toolCallId =
            typeof d.tool_call_id === "string" ? d.tool_call_id : "";
          const name = toolCallNames.get(toolCallId) ?? "unknown";
          emitAgentEvent({
            runId,
            sessionKey,
            stream: "tool",
            data: {
              phase: "result",
              name,
              toolCallId,
              result: {
                content: [{ type: "text", text: typeof d.content === "string" ? d.content : JSON.stringify(d.content) }],
              },
            },
          });
          onAgentEvent({
            stream: "tool",
            data: { phase: "result", name, toolCallId },
          });
          break;
        }

        case "accuracy_retry": {
          // Knowledge agent is retrying because LLM answered without tools
          emitAgentEvent({
            runId,
            sessionKey,
            stream: "assistant",
            data: { text: "" },
          });
          // Reset accumulated text — final answer will come from the retry
          accumulatedText = "";
          break;
        }

        case "complete": {
          // Stream finished normally — break out of the loop
          break;
        }

        case "error": {
          const message = typeof d.message === "string" ? d.message : "Remote agent error";
          emitAgentEvent({
            runId,
            sessionKey,
            stream: "error",
            data: { message },
          });
          onAgentEvent({ stream: "error", data: { message } });
          throw new Error(`Remote agent error: ${message}`);
        }

        default:
          break;
      }
    }
  } finally {
    clearTimeout(timeoutHandle);
  }

  const durationMs = Date.now() - startedAt;

  return {
    payloads: accumulatedText ? [{ text: accumulatedText }] : [],
    meta: {
      durationMs,
      aborted: false,
      stopReason: "completed",
    },
  };
}
