import type { Message, UserMessage } from "@mariozechner/pi-ai";

// ---------------------------------------------------------------------------
// OpenClaw-specific message types
//
// These types represent messages that are meaningful in OpenClaw's
// multi-channel context but should be handled specially at the LLM boundary:
//
//   - ChannelNotificationMessage: context-only, never sent to the LLM
//   - SystemAlertMessage:         converted to a brief user-role note
//
// TODO(phase-2): When Pi-Mono exposes `convertToLlm` as a public setter or
// `createAgentSession` option, activate declaration merging on
// `CustomAgentMessages` and register `openclawConvertToLlm` to handle these
// types at the LLM boundary. Until then, custom messages are handled in the
// pre-processing pipeline (sanitizeSessionHistory) before they reach Pi's
// agent loop.
// ---------------------------------------------------------------------------

/** Channel notification — delivery status, typing, presence. Context-only, never sent to LLM. */
export interface ChannelNotificationMessage {
  role: "channelNotification";
  channel: string;
  notificationType: "delivery" | "read" | "typing" | "presence";
  detail?: string;
  timestamp: number;
}

/** System alert — auth, sandbox, compaction notices. Converted to brief context note for LLM. */
export interface SystemAlertMessage {
  role: "systemAlert";
  alertType: "auth" | "sandbox" | "compaction" | "timeout" | "error";
  text: string;
  severity: "info" | "warn" | "error";
  timestamp: number;
}

/** Union of all OpenClaw-specific message types. */
export type OpenClawCustomMessage = ChannelNotificationMessage | SystemAlertMessage;

// ---------------------------------------------------------------------------
// Target convertToLlm implementation
//
// This function is exported but NOT yet wired into Pi's agent loop (see
// TODO above). It serves as the reference implementation for Phase 2.
// ---------------------------------------------------------------------------

/**
 * Input type for the OpenClaw convertToLlm function.
 * Accepts both standard Pi messages and OpenClaw custom messages.
 *
 * In Phase 2, when declaration merging is activated, this will be
 * replaced by the narrower `AgentMessage` type from pi-agent-core.
 */
type OpenClawMessageInput = (Message | OpenClawCustomMessage) & { role: string };

/**
 * Convert OpenClaw messages to LLM-compatible messages.
 *
 * - Filters out `channelNotification` messages entirely (context-only).
 * - Converts `systemAlert` messages to brief user-role context notes.
 * - Passes all standard roles (user, assistant, toolResult) through unchanged.
 */
export function openclawConvertToLlm(messages: OpenClawMessageInput[]): Message[] {
  const result: Message[] = [];
  for (const m of messages) {
    if (m.role === "channelNotification") {
      // Context-only; never sent to LLM
      continue;
    }
    if (m.role === "systemAlert") {
      const alert = m as SystemAlertMessage;
      const note: UserMessage = {
        role: "user",
        content: [{ type: "text", text: `[System: ${alert.text}]` }],
        timestamp: alert.timestamp,
      };
      result.push(note);
      continue;
    }
    // Standard LLM roles — pass through as-is.
    // When wired into Pi's pipeline, this delegates to Pi's own
    // convertToLlm for user/assistant/toolResult handling.
    result.push(m as Message);
  }
  return result;
}
