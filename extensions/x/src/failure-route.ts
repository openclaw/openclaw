import { sendDurableMessageBatch } from "openclaw/plugin-sdk/channel-outbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { redactSensitiveText } from "openclaw/plugin-sdk/security-runtime";
import type { XAccountConfig } from "./config-schema.js";

const SUMMARY_MAX_CHARS = 500;

export type XWithheldReason = "failure" | "error" | "unclassified";

const REASON_LABELS: Record<XWithheldReason, string> = {
  failure: "reported failure",
  error: "error reply",
  unclassified: "no success tag",
};

/** Bounded, redacted operator notice for a reply that was withheld from X. */
export function formatXFailureReport(params: {
  reason: XWithheldReason;
  authorHandle: string;
  postUrl: string;
  text: string;
}): string {
  const redacted = redactSensitiveText(params.text).replace(/\s+/gu, " ").trim();
  const chars = Array.from(redacted);
  const clipped =
    chars.length > SUMMARY_MAX_CHARS ? chars.slice(0, SUMMARY_MAX_CHARS).join("") + "…" : redacted;
  // Model-authored text must not ping the route's audience (for example @everyone).
  const summary = clipped.replaceAll("@", "@\u200b") || "(no text)";
  return `X reply withheld (${REASON_LABELS[params.reason]}) for @${params.authorHandle}: ${params.postUrl}\n${summary}`;
}

/** Best-effort delivery through core outbound; returns a log-safe result label. */
export async function sendXFailureReport(params: {
  cfg: OpenClawConfig;
  route: NonNullable<XAccountConfig["failureRoute"]>;
  text: string;
  signal?: AbortSignal;
}): Promise<string> {
  try {
    const result = await sendDurableMessageBatch({
      cfg: params.cfg,
      channel: params.route.channel,
      to: params.route.to,
      ...(params.route.accountId ? { accountId: params.route.accountId } : {}),
      payloads: [{ text: params.text }],
      signal: params.signal,
    });
    return result.status;
  } catch (error) {
    return `failed: ${error instanceof Error ? error.message : "unknown error"}`;
  }
}
