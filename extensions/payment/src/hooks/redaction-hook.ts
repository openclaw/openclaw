/**
 * redaction-hook.ts — before_message_write hook (defense-in-depth).
 *
 * This hook is the LAST line of defense. It scans assistant messages for
 * PAN-shaped or CVV-shaped strings in toolCall arguments. If it fires, that
 * indicates the fill-hook substitution path misbehaved — a critical security
 * event.
 *
 * In a properly functioning system, this hook should NEVER block a message.
 * Real card values are substituted by the fill hook (fill-hook.ts) and never
 * reach the LLM transcript.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { scanForCardData } from "./redact-primitives.js";

// ---------------------------------------------------------------------------
// Local types (SDK does not export these from plugin-entry)
// ---------------------------------------------------------------------------

type BeforeMessageWriteEvent = {
  message: unknown;
  sessionKey?: string;
  agentId?: string;
};

// This hook only ever blocks (never rewrites) so message is omitted intentionally.
type BeforeMessageWriteResult = {
  block: true;
};

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerRedactionHook(api: OpenClawPluginApi): void {
  api.on("before_message_write", (event, _ctx) =>
    scanMessageForCardData(event as BeforeMessageWriteEvent),
  );
}

// ---------------------------------------------------------------------------
// Hook handler (exported for testability)
// ---------------------------------------------------------------------------

export function scanMessageForCardData(
  event: BeforeMessageWriteEvent,
): BeforeMessageWriteResult | undefined {
  // Only inspect assistant messages with toolCall blocks
  const message = event.message;
  if (!message || (message as Record<string, unknown>)["role"] !== "assistant") return undefined;

  const content = (message as Record<string, unknown>)["content"];
  if (!Array.isArray(content)) return undefined;

  for (const block of content) {
    const blockType = (block as Record<string, unknown>)?.["type"];
    if (blockType !== "toolCall" && blockType !== "tool_use") continue;

    const args =
      (block as Record<string, unknown>)["arguments"] ??
      (block as Record<string, unknown>)["input"];
    if (args === undefined || args === null) continue;

    const violation = scanForCardData(args);
    if (violation) {
      // Block: set block: true. The PluginHookBeforeMessageWriteResult shape
      // has { block?, message? } — no blockReason field. The block flag alone
      // prevents the write. The violation kind/preview is not included in the
      // result to avoid leaking even a safe preview to the wrong channel.
      return { block: true };
    }
  }

  return undefined;
}
