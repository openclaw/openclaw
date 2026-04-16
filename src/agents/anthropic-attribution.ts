/**
 * Anthropic billing attribution header for OAuth (subscription) providers.
 *
 * When using the anthropic-subscription provider (OAuth token), Anthropic's
 * backend needs a billing attribution header in the system prompt to route
 * usage to plan quota instead of extra usage billing. Without this, OAuth
 * requests are billed as "extra usage" at API rates.
 *
 * The attribution header must appear as its own system prompt block (Block 0)
 * starting with "x-anthropic-billing-header:".
 */

import type { StreamFn } from "@mariozechner/pi-agent-core";
import { createHash } from "node:crypto";

/**
 * Hardcoded salt — must match the server-side validation.
 */
const FINGERPRINT_SALT = "59cf53e54c78";

/**
 * Claude Code version to report in the attribution header.
 * Should match the user-agent version sent by the Anthropic provider.
 */
const CLAUDE_CODE_VERSION = "2.1.111";

/**
 * Computes a 3-character fingerprint for attribution.
 * Algorithm: SHA256(SALT + msg[4] + msg[7] + msg[20] + version)[:3]
 */
function computeFingerprint(messageText: string, version: string): string {
  const indices = [4, 7, 20];
  const chars = indices.map((i) => messageText[i] || "0").join("");
  const input = `${FINGERPRINT_SALT}${chars}${version}`;
  const hash = createHash("sha256").update(input).digest("hex");
  return hash.slice(0, 3);
}

/**
 * Build the attribution header line for the system prompt.
 */
export function getAttributionHeader(
  firstUserMessage: string,
  version: string = CLAUDE_CODE_VERSION,
): string {
  const fingerprint = computeFingerprint(firstUserMessage, version);
  return `x-anthropic-billing-header: cc_version=${version}.${fingerprint}; cc_entrypoint=cli;`;
}

/**
 * Extract the text of the first user message from an API params object.
 */
function extractFirstUserMessageText(params: Record<string, unknown>): string {
  const messages = params.messages as Array<{ role: string; content: unknown }> | undefined;
  if (!messages) return "";
  const first = messages.find((m) => m.role === "user");
  if (!first) return "";
  if (typeof first.content === "string") return first.content;
  if (Array.isArray(first.content)) {
    const textBlock = first.content.find(
      (b: { type?: string }) => b && typeof b === "object" && b.type === "text",
    );
    return (textBlock as { text?: string })?.text ?? "";
  }
  return "";
}

/**
 * Wrap a StreamFn to inject the billing attribution header as Block 0
 * in the system prompt for Anthropic subscription (OAuth) requests.
 *
 * This uses the onPayload callback to mutate the built params before
 * they're sent to the API, ensuring the attribution header is its own
 * system prompt block at position 0.
 */
export function wrapStreamFnWithAttribution(streamFn: StreamFn): StreamFn {
  return (model, context, options) => {
    const wrappedOnPayload = (payload: unknown) => {
      const params = payload as Record<string, unknown>;
      const system = params.system as Array<{ type: string; text: string }> | undefined;
      if (system && Array.isArray(system)) {
        const firstUserText = extractFirstUserMessageText(params);
        const header = getAttributionHeader(firstUserText);
        // Prepend as Block 0
        system.unshift({ type: "text", text: header });
        console.error(
          `[attribution] injected billing header as Block 0 (${system.length} system blocks, fp=${header.slice(-4, -1)})`,
        );
      } else {
        console.error("[attribution] WARNING: no system blocks found in params");
      }
      options?.onPayload?.(payload);
    };
    return streamFn(model, context, { ...options, onPayload: wrappedOnPayload });
  };
}
