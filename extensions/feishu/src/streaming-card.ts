/**
 * Feishu Streaming Card - Card Kit streaming API for real-time text output
 */

import type { Client } from "@larksuiteoapi/node-sdk";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/feishu";
import type { FeishuDomain } from "./types.js";

type Credentials = { appId: string; appSecret: string; domain?: string };
type CardState = { cardId: string; messageId: string; sequence: number; currentText: string };
type UpdateMode = "merge" | "replace";
type PendingUpdate = { text: string; mode: UpdateMode };

/** Optional header for streaming cards (title bar with color template) */
export type StreamingCardHeader = {
  title: string;
  /** Color template: blue, green, red, orange, purple, indigo, wathet, turquoise, yellow, grey, carmine, violet, lime */
  template?: string;
};

type StreamingStartOptions = {
  replyToMessageId?: string;
  replyInThread?: boolean;
  rootId?: string;
  header?: StreamingCardHeader;
};

// Token cache (keyed by domain + appId)
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

function resolveApiBase(domain?: FeishuDomain): string {
  if (domain === "lark") {
    return "https://open.larksuite.com/open-apis";
  }
  if (domain && domain !== "feishu" && domain.startsWith("http")) {
    return `${domain.replace(/\/+$/, "")}/open-apis`;
  }
  return "https://open.feishu.cn/open-apis";
}

function resolveAllowedHostnames(domain?: FeishuDomain): string[] {
  if (domain === "lark") {
    return ["open.larksuite.com"];
  }
  if (domain && domain !== "feishu" && domain.startsWith("http")) {
    try {
      return [new URL(domain).hostname];
    } catch {
      return [];
    }
  }
  return ["open.feishu.cn"];
}

async function getToken(creds: Credentials): Promise<string> {
  const key = `${creds.domain ?? "feishu"}|${creds.appId}`;
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt > Date.now() + 60000) {
    return cached.token;
  }

  const { response, release } = await fetchWithSsrFGuard({
    url: `${resolveApiBase(creds.domain)}/auth/v3/tenant_access_token/internal`,
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: creds.appId, app_secret: creds.appSecret }),
    },
    policy: { allowedHostnames: resolveAllowedHostnames(creds.domain) },
    auditContext: "feishu.streaming-card.token",
  });
  if (!response.ok) {
    await release();
    throw new Error(`Token request failed with HTTP ${response.status}`);
  }
  const data = (await response.json()) as {
    code: number;
    msg: string;
    tenant_access_token?: string;
    expire?: number;
  };
  await release();
  if (data.code !== 0 || !data.tenant_access_token) {
    throw new Error(`Token error: ${data.msg}`);
  }
  tokenCache.set(key, {
    token: data.tenant_access_token,
    expiresAt: Date.now() + (data.expire ?? 7200) * 1000,
  });
  return data.tenant_access_token;
}


function truncateSummary(text: string, max = 50): string {
  if (!text) {
    return "";
  }
  const clean = stripHtmlTagsToText(text).replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : clean.slice(0, max - 3) + "...";
}

function stripHtmlTagsToText(text: string): string {
  if (!text) {
    return "";
  }
  return text
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

export function mergeStreamingText(
  previousText: string | undefined,
  nextText: string | undefined,
): string {
  const previous = typeof previousText === "string" ? previousText : "";
  const next = typeof nextText === "string" ? nextText : "";
  if (!next) {
    return previous;
  }
  if (!previous || next === previous) {
    return next;
  }
  if (next.startsWith(previous)) {
    return next;
  }
  if (previous.startsWith(next)) {
    return previous;
  }
  if (next.includes(previous)) {
    return next;
  }
  if (previous.includes(next)) {
    return previous;
  }

  // Merge partial overlaps, e.g. "这" + "这是" => "这是".
  const maxOverlap = Math.min(previous.length, next.length);
  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    if (previous.slice(-overlap) === next.slice(0, overlap)) {
      return `${previous}${next.slice(overlap)}`;
    }
  }
  // Fallback for fragmented partial chunks: append as-is to avoid losing tokens.
  return `${previous}${next}`;
}

export function resolveStreamingCardSendMode(options?: StreamingStartOptions) {
  if (options?.replyToMessageId) {
    return "reply";
  }
  if (options?.rootId) {
    return "root_create";
  }
  return "create";
}

/** Streaming card session manager */
export class FeishuStreamingSession {
  private client: Client;
  private state: CardState | null = null;
  private queue: Promise<void> = Promise.resolve();
  private closed = false;
  private log?: (msg: string) => void;
  private lastUpdateTime = 0;
  private pendingUpdate: PendingUpdate | null = null;
  private updateThrottleMs = 100; // Throttle updates to max 10/sec

  constructor(client: Client, _creds: Credentials, log?: (msg: string) => void) {
    this.client = client;
    this.log = log;
  }

  async start(
    receiveId: string,
    receiveIdType: "open_id" | "user_id" | "union_id" | "email" | "chat_id" = "chat_id",
    options?: StreamingStartOptions,
  ): Promise<void> {
    if (this.state) {
      return;
    }

    const cardJson: Record<string, unknown> = {
      schema: "2.0",
      config: {
        streaming_mode: true,
        summary: { content: "[Generating...]" },
        streaming_config: { print_frequency_ms: { default: 50 }, print_step: { default: 1 } },
      },
      body: {
        elements: [{ tag: "markdown", content: "⏳ Thinking...", element_id: "content" }],
      },
    };
    if (options?.header) {
      cardJson.header = {
        title: { tag: "plain_text", content: options.header.title },
        template: options.header.template ?? "blue",
      };
    }

    // Create card entity via SDK
    const createData = await this.client.cardkit.v1.card.create({
      data: {
        type: "card_json",
        data: JSON.stringify(cardJson),
      },
    });
    if ((createData.code ?? 0) !== 0 || !createData.data?.card_id) {
      throw new Error(`Create card failed: ${createData.msg}`);
    }
    const cardId = createData.data.card_id;
    const cardContent = JSON.stringify({ type: "card", data: { card_id: cardId } });

    // Prefer message.reply when we have a reply target — reply_in_thread
    // reliably routes streaming cards into Feishu topics, whereas
    // message.create with root_id may silently ignore root_id for card
    // references (card_id format).
    let sendRes;
    const sendOptions = options ?? {};
    const sendMode = resolveStreamingCardSendMode(sendOptions);
    if (sendMode === "reply") {
      sendRes = await this.client.im.message.reply({
        path: { message_id: sendOptions.replyToMessageId! },
        data: {
          msg_type: "interactive",
          content: cardContent,
          ...(sendOptions.replyInThread ? { reply_in_thread: true } : {}),
        },
      });
    } else if (sendMode === "root_create") {
      // root_id is undeclared in the SDK types but accepted at runtime
      sendRes = await this.client.im.message.create({
        params: { receive_id_type: receiveIdType },
        data: Object.assign(
          { receive_id: receiveId, msg_type: "interactive", content: cardContent },
          { root_id: sendOptions.rootId },
        ),
      });
    } else {
      sendRes = await this.client.im.message.create({
        params: { receive_id_type: receiveIdType },
        data: {
          receive_id: receiveId,
          msg_type: "interactive",
          content: cardContent,
        },
      });
    }
    if (sendRes.code !== 0 || !sendRes.data?.message_id) {
      throw new Error(`Send card failed: ${sendRes.msg}`);
    }

    this.state = { cardId, messageId: sendRes.data.message_id, sequence: 1, currentText: "" };
    this.log?.(`Started streaming: cardId=${cardId}, messageId=${sendRes.data.message_id}`);
  }

  private async updateCardContent(text: string, onError?: (error: unknown) => void): Promise<void> {
    if (!this.state) {
      return;
    }
    this.state.sequence += 1;
    await this.client.cardkit.v1.cardElement
      .content({
        path: {
          card_id: this.state.cardId,
          element_id: "content",
        },
        data: {
          content: text,
          sequence: this.state.sequence,
          uuid: `s_${this.state.cardId}_${this.state.sequence}`,
        },
      })
      .then((response) => {
        if ((response.code ?? 0) !== 0) {
          throw new Error(response.msg || `code ${response.code}`);
        }
      })
      .catch((error) => onError?.(error));
  }

  private async deleteMessage(messageId: string): Promise<void> {
    try {
      const response = await this.client.im.message.delete({
        path: { message_id: messageId },
      });
      if (response.code !== 0) {
        throw new Error(response.msg || `code ${response.code}`);
      }
    } catch (e) {
      this.log?.(`Delete failed: ${String(e)}`);
    }
  }

  async update(
    text: string,
    options?: {
      mode?: UpdateMode;
    },
  ): Promise<void> {
    if (!this.state || this.closed) {
      return;
    }
    const mode = options?.mode ?? "merge";
    const pendingBase = this.pendingUpdate?.text ?? this.state.currentText;
    const mergedInput = mode === "replace" ? text : mergeStreamingText(pendingBase, text);
    if (!mergedInput || mergedInput === this.state.currentText) {
      return;
    }

    // Throttle: skip if updated recently, but remember pending text
    const now = Date.now();
    if (now - this.lastUpdateTime < this.updateThrottleMs) {
      this.pendingUpdate = { text: mergedInput, mode: "replace" };
      return;
    }
    this.pendingUpdate = null;
    this.lastUpdateTime = now;

    this.queue = this.queue.then(async () => {
      if (!this.state || this.closed) {
        return;
      }
      const mergedText =
        mode === "replace" ? mergedInput : mergeStreamingText(this.state.currentText, mergedInput);
      if (!mergedText || mergedText === this.state.currentText) {
        return;
      }
      this.state.currentText = mergedText;
      await this.updateCardContent(mergedText, (e) => this.log?.(`Update failed: ${String(e)}`));
    });
    await this.queue;
  }

  async close(finalText?: string): Promise<void> {
    if (!this.state || this.closed) {
      return;
    }
    this.closed = true;
    await this.queue;

    const hasExplicitFinalText = finalText !== undefined;
    const pendingMerged = this.pendingUpdate
      ? this.pendingUpdate.mode === "replace"
        ? this.pendingUpdate.text
        : mergeStreamingText(this.state.currentText, this.pendingUpdate.text)
      : this.state.currentText;
    this.pendingUpdate = null;
    const text = hasExplicitFinalText ? finalText : pendingMerged;

    // Explicit finalText (even empty) must win over transient status lines.
    if (
      hasExplicitFinalText
        ? text !== this.state.currentText
        : Boolean(text && text !== this.state.currentText)
    ) {
      await this.updateCardContent(text);
      this.state.currentText = text;
    }

    // Close streaming mode
    this.state.sequence += 1;
    await this.client.cardkit.v1.card
      .settings({
        path: { card_id: this.state.cardId },
        data: {
          settings: JSON.stringify({
            config: { streaming_mode: false, summary: { content: truncateSummary(text) } },
          }),
          sequence: this.state.sequence,
          uuid: `c_${this.state.cardId}_${this.state.sequence}`,
        },
      })
      .then((response) => {
        if ((response.code ?? 0) !== 0) {
          throw new Error(response.msg || `code ${response.code}`);
        }
      })
      .catch((e) => this.log?.(`Close failed: ${String(e)}`));

    this.log?.(`Closed streaming: cardId=${this.state.cardId}`);
  }

  async discard(): Promise<void> {
    if (!this.state || this.closed) {
      return;
    }
    this.closed = true;
    await this.queue;
    const messageId = this.state.messageId;
    const cardId = this.state.cardId;
    this.pendingUpdate = null;
    await this.deleteMessage(messageId);
    this.log?.(`Discarded streaming card: cardId=${cardId}, messageId=${messageId}`);
  }

  isActive(): boolean {
    return this.state !== null && !this.closed;
  }

  getMessageId(): string | undefined {
    return this.state?.messageId;
  }
}
