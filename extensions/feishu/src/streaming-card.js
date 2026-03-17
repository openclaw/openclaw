import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/feishu";
import { resolveFeishuCardTemplate } from "./send.js";
const tokenCache = /* @__PURE__ */ new Map();
function resolveApiBase(domain) {
  if (domain === "lark") {
    return "https://open.larksuite.com/open-apis";
  }
  if (domain && domain !== "feishu" && domain.startsWith("http")) {
    return `${domain.replace(/\/+$/, "")}/open-apis`;
  }
  return "https://open.feishu.cn/open-apis";
}
function resolveAllowedHostnames(domain) {
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
async function getToken(creds) {
  const key = `${creds.domain ?? "feishu"}|${creds.appId}`;
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt > Date.now() + 6e4) {
    return cached.token;
  }
  const { response, release } = await fetchWithSsrFGuard({
    url: `${resolveApiBase(creds.domain)}/auth/v3/tenant_access_token/internal`,
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: creds.appId, app_secret: creds.appSecret })
    },
    policy: { allowedHostnames: resolveAllowedHostnames(creds.domain) },
    auditContext: "feishu.streaming-card.token"
  });
  if (!response.ok) {
    await release();
    throw new Error(`Token request failed with HTTP ${response.status}`);
  }
  const data = await response.json();
  await release();
  if (data.code !== 0 || !data.tenant_access_token) {
    throw new Error(`Token error: ${data.msg}`);
  }
  tokenCache.set(key, {
    token: data.tenant_access_token,
    expiresAt: Date.now() + (data.expire ?? 7200) * 1e3
  });
  return data.tenant_access_token;
}
function truncateSummary(text, max = 50) {
  if (!text) {
    return "";
  }
  const clean = text.replace(/\n/g, " ").trim();
  return clean.length <= max ? clean : clean.slice(0, max - 3) + "...";
}
function mergeStreamingText(previousText, nextText) {
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
  const maxOverlap = Math.min(previous.length, next.length);
  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    if (previous.slice(-overlap) === next.slice(0, overlap)) {
      return `${previous}${next.slice(overlap)}`;
    }
  }
  return `${previous}${next}`;
}
function resolveStreamingCardSendMode(options) {
  if (options?.replyToMessageId) {
    return "reply";
  }
  if (options?.rootId) {
    return "root_create";
  }
  return "create";
}
class FeishuStreamingSession {
  // Throttle updates to max 10/sec
  constructor(client, creds, log) {
    this.state = null;
    this.queue = Promise.resolve();
    this.closed = false;
    this.lastUpdateTime = 0;
    this.pendingText = null;
    this.flushTimer = null;
    this.updateThrottleMs = 100;
    this.client = client;
    this.creds = creds;
    this.log = log;
  }
  async start(receiveId, receiveIdType = "chat_id", options) {
    if (this.state) {
      return;
    }
    const apiBase = resolveApiBase(this.creds.domain);
    const elements = [
      { tag: "markdown", content: "\u23F3 Thinking...", element_id: "content" }
    ];
    if (options?.note) {
      elements.push({ tag: "hr" });
      elements.push({
        tag: "markdown",
        content: `<font color='grey'>${options.note}</font>`,
        element_id: "note"
      });
    }
    const cardJson = {
      schema: "2.0",
      config: {
        streaming_mode: true,
        summary: { content: "[Generating...]" },
        streaming_config: { print_frequency_ms: { default: 50 }, print_step: { default: 1 } }
      },
      body: { elements }
    };
    if (options?.header) {
      cardJson.header = {
        title: { tag: "plain_text", content: options.header.title },
        template: resolveFeishuCardTemplate(options.header.template) ?? "blue"
      };
    }
    const { response: createRes, release: releaseCreate } = await fetchWithSsrFGuard({
      url: `${apiBase}/cardkit/v1/cards`,
      init: {
        method: "POST",
        headers: {
          Authorization: `Bearer ${await getToken(this.creds)}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ type: "card_json", data: JSON.stringify(cardJson) })
      },
      policy: { allowedHostnames: resolveAllowedHostnames(this.creds.domain) },
      auditContext: "feishu.streaming-card.create"
    });
    if (!createRes.ok) {
      await releaseCreate();
      throw new Error(`Create card request failed with HTTP ${createRes.status}`);
    }
    const createData = await createRes.json();
    await releaseCreate();
    if (createData.code !== 0 || !createData.data?.card_id) {
      throw new Error(`Create card failed: ${createData.msg}`);
    }
    const cardId = createData.data.card_id;
    const cardContent = JSON.stringify({ type: "card", data: { card_id: cardId } });
    let sendRes;
    const sendOptions = options ?? {};
    const sendMode = resolveStreamingCardSendMode(sendOptions);
    if (sendMode === "reply") {
      sendRes = await this.client.im.message.reply({
        path: { message_id: sendOptions.replyToMessageId },
        data: {
          msg_type: "interactive",
          content: cardContent,
          ...sendOptions.replyInThread ? { reply_in_thread: true } : {}
        }
      });
    } else if (sendMode === "root_create") {
      sendRes = await this.client.im.message.create({
        params: { receive_id_type: receiveIdType },
        data: Object.assign(
          { receive_id: receiveId, msg_type: "interactive", content: cardContent },
          { root_id: sendOptions.rootId }
        )
      });
    } else {
      sendRes = await this.client.im.message.create({
        params: { receive_id_type: receiveIdType },
        data: {
          receive_id: receiveId,
          msg_type: "interactive",
          content: cardContent
        }
      });
    }
    if (sendRes.code !== 0 || !sendRes.data?.message_id) {
      throw new Error(`Send card failed: ${sendRes.msg}`);
    }
    this.state = {
      cardId,
      messageId: sendRes.data.message_id,
      sequence: 1,
      currentText: "",
      hasNote: !!options?.note
    };
    this.log?.(`Started streaming: cardId=${cardId}, messageId=${sendRes.data.message_id}`);
  }
  async updateCardContent(text, onError) {
    if (!this.state) {
      return;
    }
    const apiBase = resolveApiBase(this.creds.domain);
    this.state.sequence += 1;
    await fetchWithSsrFGuard({
      url: `${apiBase}/cardkit/v1/cards/${this.state.cardId}/elements/content/content`,
      init: {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${await getToken(this.creds)}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          content: text,
          sequence: this.state.sequence,
          uuid: `s_${this.state.cardId}_${this.state.sequence}`
        })
      },
      policy: { allowedHostnames: resolveAllowedHostnames(this.creds.domain) },
      auditContext: "feishu.streaming-card.update"
    }).then(async ({ release }) => {
      await release();
    }).catch((error) => onError?.(error));
  }
  async update(text) {
    if (!this.state || this.closed) {
      return;
    }
    const mergedInput = mergeStreamingText(this.pendingText ?? this.state.currentText, text);
    if (!mergedInput || mergedInput === this.state.currentText) {
      return;
    }
    const now = Date.now();
    if (now - this.lastUpdateTime < this.updateThrottleMs) {
      this.pendingText = mergedInput;
      return;
    }
    this.pendingText = null;
    this.lastUpdateTime = now;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.queue = this.queue.then(async () => {
      if (!this.state || this.closed) {
        return;
      }
      const mergedText = mergeStreamingText(this.state.currentText, mergedInput);
      if (!mergedText || mergedText === this.state.currentText) {
        return;
      }
      this.state.currentText = mergedText;
      await this.updateCardContent(mergedText, (e) => this.log?.(`Update failed: ${String(e)}`));
    });
    await this.queue;
  }
  async updateNoteContent(note) {
    if (!this.state || !this.state.hasNote) {
      return;
    }
    const apiBase = resolveApiBase(this.creds.domain);
    this.state.sequence += 1;
    await fetchWithSsrFGuard({
      url: `${apiBase}/cardkit/v1/cards/${this.state.cardId}/elements/note/content`,
      init: {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${await getToken(this.creds)}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          content: `<font color='grey'>${note}</font>`,
          sequence: this.state.sequence,
          uuid: `n_${this.state.cardId}_${this.state.sequence}`
        })
      },
      policy: { allowedHostnames: resolveAllowedHostnames(this.creds.domain) },
      auditContext: "feishu.streaming-card.note-update"
    }).then(async ({ release }) => {
      await release();
    }).catch((e) => this.log?.(`Note update failed: ${String(e)}`));
  }
  async close(finalText, options) {
    if (!this.state || this.closed) {
      return;
    }
    this.closed = true;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    await this.queue;
    const pendingMerged = mergeStreamingText(this.state.currentText, this.pendingText ?? void 0);
    const text = finalText ? mergeStreamingText(pendingMerged, finalText) : pendingMerged;
    const apiBase = resolveApiBase(this.creds.domain);
    if (text && text !== this.state.currentText) {
      await this.updateCardContent(text);
      this.state.currentText = text;
    }
    if (options?.note) {
      await this.updateNoteContent(options.note);
    }
    this.state.sequence += 1;
    await fetchWithSsrFGuard({
      url: `${apiBase}/cardkit/v1/cards/${this.state.cardId}/settings`,
      init: {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${await getToken(this.creds)}`,
          "Content-Type": "application/json; charset=utf-8"
        },
        body: JSON.stringify({
          settings: JSON.stringify({
            config: { streaming_mode: false, summary: { content: truncateSummary(text) } }
          }),
          sequence: this.state.sequence,
          uuid: `c_${this.state.cardId}_${this.state.sequence}`
        })
      },
      policy: { allowedHostnames: resolveAllowedHostnames(this.creds.domain) },
      auditContext: "feishu.streaming-card.close"
    }).then(async ({ release }) => {
      await release();
    }).catch((e) => this.log?.(`Close failed: ${String(e)}`));
    const finalState = this.state;
    this.state = null;
    this.pendingText = null;
    this.log?.(`Closed streaming: cardId=${finalState.cardId}`);
  }
  isActive() {
    return this.state !== null && !this.closed;
  }
}
export {
  FeishuStreamingSession,
  mergeStreamingText,
  resolveStreamingCardSendMode
};
