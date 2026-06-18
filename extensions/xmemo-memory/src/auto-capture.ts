// Auto-capture lifecycle hooks for XMemo.
//
// After a successful agent run, inspect user messages for high-signal snippets
// (preferences, decisions, facts, contact info) and store them in XMemo. XMemo
// handles embeddings remotely, so no local vector store is required.

import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { resolveLivePluginConfigObject } from "openclaw/plugin-sdk/plugin-config-runtime";
import { XMemoClient } from "./client.js";
import { resolveXMemoMemoryConfig, type XMemoMemoryConfig } from "./config.js";

type AutoCaptureCursor = {
  nextIndex: number;
  lastMessageFingerprint?: string;
};

const CURSORS = new Map<string, AutoCaptureCursor>();

const LEADING_TIMESTAMP_RE = /^\[[A-Za-z]{3} \d{4}-\d{2}-\d{2} \d{2}:\d{2}[^\]]*\] */;
const MEDIA_ATTACHED_RE = /\[media attached(?:\s+\d+\/\d+)?:[^\]]*\]/gi;
const ACTIVE_MEMORY_RE = /<active_memory_plugin>[\s\S]*?<\/active_memory_plugin>/g;
const UNTRUSTED_CONTEXT_RE = /^Untrusted context \(metadata[\s\S]*$/m;
const RELEVANT_MEMORIES_RE = /<relevant-memories>[\s\S]*?<\/relevant-memories>/g;

const MEMORY_TRIGGERS = [
  /\b(remember|recall|save this|keep in mind|don't forget|note that)\b/i,
  /\b(prefer|preference|like|love|hate|want|need)\b/i,
  /\b(decided|decision|we will use|let's use|going forward|from now on)\b/i,
  /\b(my name is|i am|my email|my phone|my address|contact me at)\b/i,
  /\b(always|never|important|crucial|critical)\b/i,
  /\b(记住|记下|保存|不要忘记|注意)\b/i,
  /\b(喜欢|偏好|讨厌|想要|需要)\b/i,
  /\b(决定|我们使用|以后|重要)\b/i,
  /\b(覚えて|記憶して|忘れないで|好み|いつも|絶対|重要)\b/i,
  /\b(기억해|기억해줘|잊지 마|좋아|싫어|항상|절대|중요)\b/i,
];

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function messageFingerprint(message: unknown): string {
  const obj = asRecord(message);
  if (!obj) {
    return `${typeof message}:${String(message)}`;
  }
  try {
    return JSON.stringify({ role: obj.role, content: obj.content });
  } catch {
    return `${String(obj.role)}:${String(obj.content)}`;
  }
}

function extractUserTextContent(message: unknown): string[] {
  const obj = asRecord(message);
  if (!obj || obj.role !== "user") {
    return [];
  }

  const content = obj.content;
  if (typeof content === "string") {
    return [content];
  }
  if (!Array.isArray(content)) {
    return [];
  }

  const texts: string[] = [];
  for (const block of content) {
    const blockObj = asRecord(block);
    if (blockObj?.type === "text" && typeof blockObj.text === "string") {
      texts.push(blockObj.text);
    }
  }
  return texts;
}

function resolveStartIndex(messages: unknown[], cursor: AutoCaptureCursor | undefined): number {
  if (!cursor) {
    return 0;
  }
  if (cursor.lastMessageFingerprint && cursor.nextIndex > 0) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messageFingerprint(messages[index]) === cursor.lastMessageFingerprint) {
        return index + 1;
      }
    }
    return 0;
  }
  if (cursor.nextIndex <= messages.length) {
    return cursor.nextIndex;
  }
  return 0;
}

function sanitizeForCapture(text: string): string {
  let cleaned = text.length > 10_000 ? text.slice(0, 10_000) : text;
  cleaned = cleaned.replace(LEADING_TIMESTAMP_RE, "");
  cleaned = cleaned.replace(MEDIA_ATTACHED_RE, "");
  cleaned = cleaned.replace(ACTIVE_MEMORY_RE, "");
  cleaned = cleaned.replace(RELEVANT_MEMORIES_RE, "");
  const untrustedMatch = UNTRUSTED_CONTEXT_RE.exec(cleaned);
  if (untrustedMatch?.index !== undefined) {
    cleaned = cleaned.slice(0, untrustedMatch.index);
  }
  cleaned = cleaned
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
  return cleaned;
}

function matchesCustomTrigger(text: string, customTriggers?: string[]): boolean {
  if (!customTriggers || customTriggers.length === 0) {
    return false;
  }
  const lower = text.toLocaleLowerCase();
  return customTriggers.some((trigger) => lower.includes(trigger.toLocaleLowerCase()));
}

function looksLikeEnvelopeSludge(text: string): boolean {
  if (!text) {
    return false;
  }
  return (
    /^Untrusted context \(metadata/m.test(text) ||
    text.includes("(untrusted metadata):") ||
    /\[media attached/i.test(text) ||
    /<active_memory_plugin>/i.test(text) ||
    /<relevant-memories>/i.test(text) ||
    /^\[Channel /m.test(text) ||
    /^Conversation info /m.test(text)
  );
}

function looksLikePromptInjection(text: string): boolean {
  return /<\s*(system|assistant|developer|tool|function|relevant-memories)\b/i.test(text);
}

function shouldCapture(
  text: string,
  options: { maxChars: number; customTriggers?: string[] },
): boolean {
  if (looksLikeEnvelopeSludge(text)) {
    return false;
  }
  if (text.length > options.maxChars) {
    return false;
  }
  if (text.includes("<relevant-memories>")) {
    return false;
  }
  if (text.startsWith("<") && text.includes("</")) {
    return false;
  }
  if (looksLikePromptInjection(text)) {
    return false;
  }
  const hasTrigger =
    MEMORY_TRIGGERS.some((r) => r.test(text)) || matchesCustomTrigger(text, options.customTriggers);
  if (!hasTrigger) {
    return false;
  }
  if (text.length < 10) {
    return false;
  }
  return true;
}

function detectCategory(text: string): string {
  const lower = text.toLowerCase();
  if (
    /prefer|like|love|hate|want|need|偏好|喜欢|喜歡|讨厌|討厭|愛|好き|嫌い|좋아|싫어|원해|필요/.test(
      lower,
    )
  ) {
    return "preference";
  }
  if (
    /decided|decision|will use|going forward|决定|決定|以后都用|以後都用|これから|앞으로/.test(
      lower,
    )
  ) {
    return "decision";
  }
  if (/my name|email|phone|address|contact|is called|\+\d{10,}|@[\w.-]+\.\w+/.test(lower)) {
    return "entity";
  }
  if (/\b(is|are|has|have|je|má|jsou)\b/i.test(lower)) {
    return "fact";
  }
  return "other";
}

function resolveCurrentConfig(
  api: OpenClawPluginApi,
  startupConfig: XMemoMemoryConfig,
): XMemoMemoryConfig {
  const runtimeLoader = api.runtime?.config?.current
    ? () => api.runtime.config.current() as OpenClawConfig
    : undefined;
  const live = resolveLivePluginConfigObject(runtimeLoader, "xmemo-memory", api.pluginConfig);
  if (!live) {
    return startupConfig;
  }
  return {
    ...startupConfig,
    autoCapture: (live.autoCapture as boolean | undefined) ?? startupConfig.autoCapture,
    captureMaxChars: (live.captureMaxChars as number | undefined) ?? startupConfig.captureMaxChars,
    customTriggers: Array.isArray(live.customTriggers)
      ? (live.customTriggers as string[])
      : startupConfig.customTriggers,
  };
}

function buildClient(cfg: XMemoMemoryConfig): XMemoClient | null {
  if (!cfg.apiKey) {
    return null;
  }
  return new XMemoClient(cfg.baseUrl, cfg.apiKey, cfg.agentId, cfg.agentInstanceId, cfg.authMode);
}

export function registerXMemoAutoCapture(api: OpenClawPluginApi): void {
  const startupConfig = resolveXMemoMemoryConfig(api.config);

  api.on("agent_end", async (event, ctx) => {
    const cfg = resolveCurrentConfig(api, startupConfig);
    if (!cfg.autoCapture) {
      return;
    }
    if (!event.success || !event.messages || event.messages.length === 0) {
      return;
    }

    const client = buildClient(cfg);
    if (!client) {
      return;
    }

    const cursorKey = ctx.sessionKey ?? ctx.sessionId;
    const startIndex = resolveStartIndex(
      event.messages,
      cursorKey ? CURSORS.get(cursorKey) : undefined,
    );

    let stored = 0;
    let capturableSeen = 0;

    for (let index = startIndex; index < event.messages.length; index += 1) {
      const message = event.messages[index];
      let messageProcessed = false;

      try {
        for (const text of extractUserTextContent(message)) {
          const sanitized = sanitizeForCapture(text);
          if (
            !sanitized ||
            !shouldCapture(sanitized, {
              maxChars: cfg.captureMaxChars,
              customTriggers: cfg.customTriggers,
            })
          ) {
            continue;
          }

          capturableSeen += 1;
          if (capturableSeen > 3) {
            continue;
          }

          const category = detectCategory(sanitized);

          try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 10_000);
            try {
              await client.remember(
                {
                  content: sanitized,
                  path: cfg.bucket,
                  bucket: cfg.bucket,
                  scope: cfg.scope ?? null,
                  team_id: cfg.teamId ?? null,
                  memory_type: "auto",
                  importance: 0.7,
                  source: "openclaw-auto-capture",
                  metadata: { category },
                },
                controller.signal,
              );
              stored += 1;
            } finally {
              clearTimeout(timeout);
            }
          } catch (err) {
            api.logger.warn(`xmemo-memory: auto-capture store failed: ${String(err)}`);
          }
        }
        messageProcessed = true;
      } finally {
        if (messageProcessed && cursorKey) {
          CURSORS.set(cursorKey, {
            nextIndex: index + 1,
            lastMessageFingerprint: messageFingerprint(message),
          });
        }
      }
    }

    if (stored > 0) {
      api.logger.info(`xmemo-memory: auto-captured ${stored} memories`);
    }
  });

  api.on("session_end", (_event, ctx) => {
    const cursorKey = ctx.sessionKey ?? ctx.sessionId;
    if (cursorKey) {
      CURSORS.delete(cursorKey);
    }
  });
}
