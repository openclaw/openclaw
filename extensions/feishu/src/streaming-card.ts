/**
 * Feishu Streaming Card - Card Kit streaming API for real-time text output
 */

import type { Client } from "@larksuiteoapi/node-sdk";
import type { FeishuDomain } from "./types.js";

type Credentials = { appId: string; appSecret: string; domain?: FeishuDomain };
type CardState = { cardId: string; messageId: string; sequence: number; currentText: string };

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

async function getToken(creds: Credentials): Promise<string> {
  const key = `${creds.domain ?? "feishu"}|${creds.appId}`;
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt > Date.now() + 60000) {
    return cached.token;
  }

  const res = await fetch(`${resolveApiBase(creds.domain)}/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: creds.appId, app_secret: creds.appSecret }),
  });
  const data = (await res.json()) as {
    code: number;
    msg: string;
    tenant_access_token?: string;
    expire?: number;
  };
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
  const clean = text.replace(/\n/g, " ").trim();
  return clean.length <= max ? clean : clean.slice(0, max - 3) + "...";
}

/** Streaming card session manager */
export class FeishuStreamingSession {
  private client: Client;
  private creds: Credentials;
  private state: CardState | null = null;
  private queue: Promise<void> = Promise.resolve();
  private closed = false;
  private log?: (msg: string) => void;
  private lastUpdateTime = 0;
  private pendingText: string | null = null;
  private updateThrottleMs = 100; // Throttle updates to max 10/sec

  constructor(client: Client, creds: Credentials, log?: (msg: string) => void) {
    this.client = client;
    this.creds = creds;
    this.log = log;
  }

  async start(
    receiveId: string,
    receiveIdType: "open_id" | "user_id" | "union_id" | "email" | "chat_id" = "chat_id",
  ): Promise<void> {
    if (this.state) {
      return;
    }

    const apiBase = resolveApiBase(this.creds.domain);
    const cardJson = {
      schema: "2.0",
      config: {
        streaming_mode: true,
        summary: { content: "[Generating...]" },
        streaming_config: { print_frequency_ms: { default: 50 }, print_step: { default: 2 } },
      },
      body: {
        elements: [{ tag: "markdown", content: "⏳ Thinking...", element_id: "content" }],
      },
    };

    // Create card entity
    const createRes = await fetch(`${apiBase}/cardkit/v1/cards`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${await getToken(this.creds)}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ type: "card_json", data: JSON.stringify(cardJson) }),
    });
    const createData = (await createRes.json()) as {
      code: number;
      msg: string;
      data?: { card_id: string };
    };
    if (createData.code !== 0 || !createData.data?.card_id) {
      throw new Error(`Create card failed: ${createData.msg}`);
    }
    const cardId = createData.data.card_id;

    // Send card message
    const sendRes = await this.client.im.message.create({
      params: { receive_id_type: receiveIdType },
      data: {
        receive_id: receiveId,
        msg_type: "interactive",
        content: JSON.stringify({ type: "card", data: { card_id: cardId } }),
      },
    });
    if (sendRes.code !== 0 || !sendRes.data?.message_id) {
      throw new Error(`Send card failed: ${sendRes.msg}`);
    }

    this.state = { cardId, messageId: sendRes.data.message_id, sequence: 1, currentText: "" };
    this.log?.(`Started streaming: cardId=${cardId}, messageId=${sendRes.data.message_id}`);
  }

  async update(text: string): Promise<void> {
    if (!this.state || this.closed) {
      return;
    }
    // Throttle: skip if updated recently, but remember pending text
    const now = Date.now();
    if (now - this.lastUpdateTime < this.updateThrottleMs) {
      this.pendingText = text;
      return;
    }
    this.pendingText = null;
    this.lastUpdateTime = now;

    this.queue = this.queue.then(async () => {
      if (!this.state || this.closed) {
        return;
      }
      this.state.currentText = text;
      this.state.sequence += 1;
      const apiBase = resolveApiBase(this.creds.domain);
      await fetch(`${apiBase}/cardkit/v1/cards/${this.state.cardId}/elements/content/content`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${await getToken(this.creds)}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          content: text,
          sequence: this.state.sequence,
          uuid: `s_${this.state.cardId}_${this.state.sequence}`,
        }),
      }).catch((e) => this.log?.(`Update failed: ${String(e)}`));
    });
    await this.queue;
  }

  async close(finalText?: string): Promise<void> {
    if (!this.state || this.closed) {
      return;
    }
    this.closed = true;
    await this.queue;

    // Use finalText, or pending throttled text, or current text
    const text = finalText ?? this.pendingText ?? this.state.currentText;
    const apiBase = resolveApiBase(this.creds.domain);

    // Only send final update if content differs from what's already displayed
    if (text && text !== this.state.currentText) {
      this.state.sequence += 1;
      await fetch(`${apiBase}/cardkit/v1/cards/${this.state.cardId}/elements/content/content`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${await getToken(this.creds)}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          content: text,
          sequence: this.state.sequence,
          uuid: `s_${this.state.cardId}_${this.state.sequence}`,
        }),
      }).catch(() => {});
      this.state.currentText = text;
    }

    // Close streaming mode
    this.state.sequence += 1;
    await fetch(`${apiBase}/cardkit/v1/cards/${this.state.cardId}/settings`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${await getToken(this.creds)}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        settings: JSON.stringify({
          config: { streaming_mode: false, summary: { content: truncateSummary(text) } },
        }),
        sequence: this.state.sequence,
        uuid: `c_${this.state.cardId}_${this.state.sequence}`,
      }),
    }).catch((e) => this.log?.(`Close failed: ${String(e)}`));

    this.log?.(`Closed streaming: cardId=${this.state.cardId}`);
  }

  isActive(): boolean {
    return this.state !== null && !this.closed;
  }
}
