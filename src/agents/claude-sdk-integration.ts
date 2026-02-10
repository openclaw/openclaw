/**
 * Claude Agent SDK Integration
 *
 * subprocess 방식 대신 Claude Agent SDK를 사용하여 Claude Code를 실행합니다.
 * 이를 통해 타임아웃 문제를 해결하고 더 안정적인 에이전트 실행이 가능합니다.
 *
 * @see https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk
 */

import {
  query,
  type Options,
  type SDKResultError,
  type SDKAssistantMessageError,
} from "@anthropic-ai/claude-agent-sdk";
import type { FailoverReason } from "./pi-embedded-helpers/types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { FailoverError, resolveFailoverStatus } from "./failover-error.js";
import { classifyFailoverReason, isFailoverErrorMessage } from "./pi-embedded-helpers.js";

const log = createSubsystemLogger("agent/claude-sdk");

export interface SDKAgentParams {
  prompt: string;
  cwd: string;
  model?: string;
  systemPromptAppend?: string;
  maxTurns?: number;
  sessionId?: string;
  resume?: string;
  env?: Record<string, string | undefined>;
}

export interface SDKAgentResult {
  text: string;
  sessionId: string;
  durationMs: number;
  numTurns: number;
  totalCostUsd: number;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
}

const DEFAULT_MAX_TURNS = 250;

export function classifySDKAssistantError(
  errorType: SDKAssistantMessageError,
): FailoverReason | null {
  switch (errorType) {
    case "authentication_failed":
      return "auth";
    case "billing_error":
      return "billing";
    case "rate_limit":
      return "rate_limit";
    case "invalid_request":
      return "format";
    case "server_error":
      return "unknown";
    case "max_output_tokens":
      return null;
    case "unknown":
      return "unknown";
    default:
      return null;
  }
}

export function classifySDKResultError(subtype: SDKResultError["subtype"]): FailoverReason {
  switch (subtype) {
    case "error_max_turns":
      return "timeout";
    case "error_max_budget_usd":
      return "billing";
    case "error_max_structured_output_retries":
      return "format";
    case "error_during_execution":
      return "unknown";
    default:
      return "unknown";
  }
}

export async function runSDKAgent(params: SDKAgentParams): Promise<SDKAgentResult> {
  const systemPrompt: Options["systemPrompt"] = params.systemPromptAppend
    ? { type: "preset" as const, preset: "claude_code" as const, append: params.systemPromptAppend }
    : { type: "preset" as const, preset: "claude_code" as const };

  const options: Options = {
    cwd: params.cwd,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    maxTurns: params.maxTurns ?? DEFAULT_MAX_TURNS,
    systemPrompt,
    settingSources: ["user", "project", "local"],
    ...(params.model && { model: params.model }),
    ...(params.env && { env: params.env }),
    ...(params.resume
      ? { resume: params.resume }
      : params.sessionId
        ? { sessionId: params.sessionId }
        : {}),
  };

  log.info(
    `sdk exec: model=${params.model ?? "default"} promptChars=${params.prompt.length} maxTurns=${options.maxTurns}`,
  );

  try {
    for await (const msg of query({ prompt: params.prompt, options })) {
      if (msg.type === "assistant") {
        if (msg.error) {
          log.warn(`sdk assistant error: ${msg.error}`);

          const reason = classifySDKAssistantError(msg.error);
          if (reason) {
            const status = resolveFailoverStatus(reason);
            throw new FailoverError(`SDK assistant error: ${msg.error}`, {
              reason,
              status,
            });
          }
        }
      }

      if (msg.type === "result") {
        if (msg.subtype === "success") {
          return {
            text: msg.result,
            sessionId: msg.session_id,
            durationMs: msg.duration_ms,
            numTurns: msg.num_turns,
            totalCostUsd: msg.total_cost_usd,
            usage: {
              input: msg.usage.input_tokens,
              output: msg.usage.output_tokens,
              cacheRead: msg.usage.cache_read_input_tokens,
              cacheWrite: msg.usage.cache_creation_input_tokens,
            },
          };
        }

        const reason = classifySDKResultError(msg.subtype);
        const status = resolveFailoverStatus(reason);
        const errorMessages = msg.errors?.length ? msg.errors.join("; ") : msg.subtype;
        throw new FailoverError(`SDK result error: ${errorMessages}`, {
          reason,
          status,
        });
      }
    }

    // Stream ended without a result message
    throw new FailoverError("SDK stream ended unexpectedly without a result", {
      reason: "unknown",
    });
  } catch (err) {
    if (err instanceof FailoverError) {
      throw err;
    }

    const message = err instanceof Error ? err.message : String(err);

    if (isFailoverErrorMessage(message)) {
      const reason = classifyFailoverReason(message) ?? "unknown";
      const status = resolveFailoverStatus(reason);
      throw new FailoverError(message, { reason, status });
    }

    throw new FailoverError(`SDK execution failed: ${message}`, {
      reason: "unknown",
      cause: err instanceof Error ? err : undefined,
    });
  }
}
