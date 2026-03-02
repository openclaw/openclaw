import type { OpenClawConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { FailoverError, resolveFailoverStatus } from "./failover-error.js";
import type { EmbeddedPiRunResult } from "./pi-embedded-runner.js";

const log = createSubsystemLogger("agent/claude-sdk");

/**
 * Runs a single query via the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`).
 *
 * The SDK spawns a Claude Code CLI process internally and communicates via
 * stdin/stdout JSON protocol, providing native streaming (content_block_delta)
 * without the CLI `-p` flag limitations.
 */
export async function runSdkAgent(params: {
  sessionId: string;
  prompt: string;
  model?: string;
  workspaceDir: string;
  config?: OpenClawConfig;
  timeoutMs: number;
  runId: string;
  systemPrompt?: string;
  onStreamText?: (text: string) => void;
  cliSessionId?: string;
}): Promise<EmbeddedPiRunResult> {
  const started = Date.now();
  const modelId = (params.model ?? "opus").trim() || "opus";

  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), params.timeoutMs);

  let fullText = "";
  let sessionId: string | undefined;
  let usage:
    | { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }
    | undefined;

  try {
    // Dynamic import: SDK is ESM-only and may not be installed in all environments
    const { query: agentQuery } = await import("@anthropic-ai/claude-agent-sdk");

    const env: Record<string, string | undefined> = { ...process.env };
    // Clear API keys so SDK uses CLI's own auth (Max subscription)
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_API_KEY_OLD;

    log.info(
      `sdk exec: model=${modelId} promptChars=${params.prompt.length} resume=${params.cliSessionId ?? "none"}`,
    );

    const response = agentQuery({
      prompt: params.prompt,
      options: {
        cwd: params.workspaceDir,
        model: modelId,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        systemPrompt: params.systemPrompt,
        resume: params.cliSessionId,
        abortController,
        env,
        // Disable session persistence — OpenClaw manages its own sessions
        persistSession: true,
      },
    });

    for await (const message of response) {
      if (message.type === "system" && message.subtype === "init") {
        sessionId = message.session_id;
        log.info(`sdk session: ${sessionId}`);
      }

      log.debug(
        `sdk msg: type=${message.type} subtype=${"subtype" in message ? message.subtype : "-"}`,
      );

      // Result message — SDK may send final text here
      if (message.type === "result") {
        const text = "text" in message && typeof message.text === "string" ? message.text : "";
        if (text && !fullText) {
          fullText += text;
          params.onStreamText?.(text);
        }
      }

      // Streaming text deltas
      if (message.type === "stream_event") {
        const event = message.event;
        if (
          event?.type === "content_block_delta" &&
          "delta" in event &&
          event.delta?.type === "text_delta" &&
          "text" in event.delta &&
          typeof event.delta.text === "string"
        ) {
          fullText += event.delta.text;
          params.onStreamText?.(event.delta.text);
        }
      }

      // Final assistant message with usage + text content fallback
      if (message.type === "assistant" && message.message) {
        const msg = message.message;
        if (msg.usage) {
          const u = msg.usage;
          usage = {
            input: u.input_tokens,
            output: u.output_tokens,
            cacheRead:
              "cache_read_input_tokens" in u ? (u.cache_read_input_tokens as number) : undefined,
            cacheWrite:
              "cache_creation_input_tokens" in u
                ? (u.cache_creation_input_tokens as number)
                : undefined,
          };
        }
        // Extract text from content blocks when streaming deltas were not received
        if (!fullText && Array.isArray(msg.content)) {
          for (const block of msg.content) {
            if (
              block &&
              typeof block === "object" &&
              "type" in block &&
              block.type === "text" &&
              "text" in block &&
              typeof block.text === "string"
            ) {
              fullText += block.text;
            }
          }
          if (fullText) {
            params.onStreamText?.(fullText);
          }
        }
      }
    }
  } catch (err) {
    // AbortError from timeout
    if (abortController.signal.aborted) {
      const reason = `SDK query exceeded timeout (${Math.round(params.timeoutMs / 1000)}s) and was aborted.`;
      throw new FailoverError(reason, {
        reason: "timeout",
        provider: "claude-sdk",
        model: modelId,
        status: resolveFailoverStatus("timeout"),
        cause: err,
      });
    }
    // SDK-specific error classification
    const message = err instanceof Error ? err.message : String(err);
    log.error(`sdk error: ${message}`);
    throw new FailoverError(message, {
      reason: classifySdkError(message),
      provider: "claude-sdk",
      model: modelId,
      status: resolveFailoverStatus(classifySdkError(message)),
      cause: err,
    });
  } finally {
    clearTimeout(timer);
  }

  const text = fullText.trim();
  const durationMs = Date.now() - started;
  log.info(`sdk done: model=${modelId} chars=${text.length} durationMs=${durationMs}`);

  return {
    payloads: text ? [{ text }] : undefined,
    meta: {
      durationMs,
      agentMeta: {
        sessionId: sessionId ?? params.cliSessionId ?? "",
        provider: "claude-sdk",
        model: modelId,
        usage,
      },
    },
  };
}

function classifySdkError(message: string): "auth" | "rate_limit" | "timeout" | "unknown" {
  if (/auth|unauthorized|unauthenticated/i.test(message)) {
    return "auth";
  }
  if (/rate.?limit|too many requests/i.test(message)) {
    return "rate_limit";
  }
  if (/timeout|timed out|abort/i.test(message)) {
    return "timeout";
  }
  return "unknown";
}
