import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { generateConversationLabel } from "openclaw/plugin-sdk/reply-dispatch-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { truncateWithMarker } from "openclaw/plugin-sdk/string-normalization-runtime";

const DEFAULT_THREAD_TITLE_TIMEOUT_MS = 60_000;
const MAX_THREAD_TITLE_SOURCE_CHARS = 600;
const MAX_THREAD_TITLE_CHANNEL_NAME_CHARS = 120;
const MAX_THREAD_TITLE_CHANNEL_DESCRIPTION_CHARS = 320;
const DISCORD_THREAD_TITLE_SYSTEM_PROMPT =
  "Generate a concise Discord thread title (3-6 words) in sentence case: capitalize only the first word and words that are always capitalized. Return only the title. Use channel context when provided and avoid redundant channel-name words unless needed for clarity.";

export async function generateThreadTitle(params: {
  cfg: OpenClawConfig;
  agentId: string;
  messageText: string;
  modelRef?: string;
  channelName?: string;
  channelDescription?: string;
  timeoutMs?: number;
}): Promise<string | null> {
  const sourceText = params.messageText.trim();
  if (!sourceText) {
    return null;
  }

  try {
    const { channelName: rawChannelName, channelDescription: rawChannelDescription } = params;
    const titleSourceText = truncateThreadTitleText(sourceText, MAX_THREAD_TITLE_SOURCE_CHARS);
    const channelName = normalizeTitleContextField(
      rawChannelName,
      MAX_THREAD_TITLE_CHANNEL_NAME_CHARS,
    );
    const channelDescription = normalizeTitleContextField(
      rawChannelDescription,
      MAX_THREAD_TITLE_CHANNEL_DESCRIPTION_CHARS,
    );
    const userMessage = [
      channelName ? `Channel: ${channelName}` : undefined,
      channelDescription ? `Channel description: ${channelDescription}` : undefined,
      `Message:\n${titleSourceText}`,
    ]
      .filter(Boolean)
      .join("\n\n");
    const generated = await generateConversationLabel({
      cfg: params.cfg,
      agentId: params.agentId,
      userMessage,
      prompt: DISCORD_THREAD_TITLE_SYSTEM_PROMPT,
      ...(params.modelRef ? { modelRef: params.modelRef } : {}),
      timeoutMs: Math.max(100, Math.floor(params.timeoutMs ?? DEFAULT_THREAD_TITLE_TIMEOUT_MS)),
      maxLength: MAX_THREAD_TITLE_SOURCE_CHARS,
    });
    return generated ? normalizeGeneratedThreadTitle(generated) : null;
  } catch (err) {
    logVerbose(`thread-title: title generation failed for agent ${params.agentId}: ${String(err)}`);
    return null;
  }
}

function truncateThreadTitleText(text: string, maxChars: number): string {
  return truncateWithMarker(text, maxChars, { marker: "...", reserve: 0, trimEnd: false });
}

function normalizeGeneratedThreadTitle(raw: string): string {
  const firstLine = raw
    .replace(/\r/g, "")
    .split("\n")
    .find((line) => line.trim() && !line.trim().startsWith("```"));
  return stripThreadTitleWrappers(firstLine ?? "");
}

function stripThreadTitleWrappers(raw: string): string {
  let current = raw.trim();
  let previous = "";
  while (current && current !== previous) {
    previous = current;
    current = current.replace(/^["'`]+|["'`]+$/g, "").trim();
    // Preserve separate spans ("*Plan* for *project*") while unwrapping nested emphasis.
    for (const marker of ["**", "__", "*", "_", "~~"]) {
      current = stripBalancedWrapper(current, marker);
    }
  }
  return current;
}

function stripBalancedWrapper(text: string, marker: string): string {
  if (text.length < marker.length * 2 + 1 || !text.startsWith(marker) || !text.endsWith(marker)) {
    return text;
  }
  const inner = text.slice(marker.length, text.length - marker.length);
  return inner.includes(marker) ? text : inner;
}

function normalizeTitleContextField(raw: string | undefined, maxChars: number): string | undefined {
  const value = raw?.trim();
  if (!value) {
    return undefined;
  }
  return truncateThreadTitleText(value.replace(/\s+/g, " "), maxChars);
}
