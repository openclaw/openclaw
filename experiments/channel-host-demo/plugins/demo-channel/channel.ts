/**
 * Demo Channel — HTTP Webhook 收发实现
 *
 * 参考 openclaw extensions/irc/src/channel.ts 的收发模式，简化为 HTTP webhook：
 *
 * IRC 收发模式（原版）：
 *   接收：socket onPrivmsg → handleIrcInbound() → dispatchInboundReply() → AI
 *   发送：sendReply 回调 → client.sendPrivmsg(target, text)
 *
 * Demo 简化版：
 *   接收：HTTP POST /message → ctx.onMessage() → agent.ts 固定回复
 *   发送：outbound.sendText() → 打印到 console（+ HTTP 响应）
 *
 * 运行后监听 http://localhost:<port>/message
 * 接受 POST body: { "from": "user1", "text": "hello" }
 * 响应: { "reply": "我知道了" }
 */

import http from "node:http";
import type { ChannelPlugin, DemoChannelGatewayContext } from "../../src/types.js";

/** Demo channel 的账户配置
 * 对应 IRC 的 ResolvedIrcAccount（extensions/irc/src/channel.ts）
 */
export type ResolvedDemoAccount = {
  accountId: string;
  port: number;
  configured: boolean;
};

/** Demo channel 配置 JSON 格式
 * 支持两种结构（兼容完整 openclaw.json 和最小 demo cfg）：
 *   完整格式: { channels: { "demo-channel": { port: 3001 } } }  ← openclaw.json
 *   简写格式: { "demo-channel": { port: 3001 } }               ← 旧版 demo cfg（向后兼容）
 */
type DemoCfg = {
  channels?: {
    "demo-channel"?: { port?: number };
  };
  "demo-channel"?: { port?: number };
};

const CHANNEL_ID = "demo-channel";
const DEFAULT_PORT = 3000;

// ─── 辅助函数 ──────────────────────────────────────────────────────────────

/** 读取 HTTP request body */
async function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

/** 解析账户端口（从 cfg 中读取，或使用默认值）
 * 兼容完整 openclaw.json（cfg.channels["demo-channel"].port）
 * 和旧版简写格式（cfg["demo-channel"].port）
 */
function resolvePort(cfg: unknown, accountId: string): number {
  const demoCfg = cfg as DemoCfg;
  // 支持后续多账户时用 accountId 区分端口
  void accountId;
  // 优先读 openclaw.json 标准格式
  return demoCfg?.channels?.[CHANNEL_ID]?.port ?? demoCfg?.[CHANNEL_ID]?.port ?? DEFAULT_PORT;
}

// ─── ChannelPlugin 定义 ────────────────────────────────────────────────────

/**
 * demoChannelPlugin：ChannelPlugin 接口实现
 * 对应 openclaw extensions/irc/src/channel.ts 中的 ircPlugin 对象
 */
export const demoChannelPlugin: ChannelPlugin<ResolvedDemoAccount> = {
  id: CHANNEL_ID,

  // 对应 openclaw channel.ts 中的 meta 字段
  // 官方 ChannelMeta 必填字段：id / label / selectionLabel / docsPath / blurb
  // 迁移到 VSCode 时，docsPath 指向 docs 站实际路径，selectionLabel 用于 UI 选择列表
  meta: {
    id: CHANNEL_ID,
    label: "Demo HTTP Channel",
    selectionLabel: "Demo HTTP",
    docsPath: "/channels/demo",
    blurb: "Local HTTP endpoint for development and testing",
  },

  // 对应 openclaw channel.ts 中的 capabilities 字段
  capabilities: {
    chatTypes: ["direct"],
  },

  // 对应 openclaw extensions/irc/src/channel.ts config 适配器
  config: {
    /**
     * 列出所有账户 id
     * IRC 原版：解析 cfg.channels.irc.accounts 或返回 [DEFAULT_ACCOUNT_ID]
     * 本工程简化：固定返回单账户
     */
    listAccountIds: (_cfg: unknown): string[] => {
      return ["default"];
    },

    /**
     * 解析账户对象
     * IRC 原版：resolveIrcAccount(cfg, accountId)，读取 host/nick/port 等配置
     * 本工程简化：只读取 port
     */
    resolveAccount: (cfg: unknown, accountId?: string | null): ResolvedDemoAccount => {
      const id = accountId ?? "default";
      const port = resolvePort(cfg, id);
      return {
        accountId: id,
        port,
        configured: true,
      };
    },

    isConfigured: (account: ResolvedDemoAccount): boolean => account.configured,
    isEnabled: (_account: ResolvedDemoAccount): boolean => true,
  },

  // ─── Gateway 适配器（消息接收）──────────────────────────────────────────
  // 对应 openclaw extensions/irc/src/channel.ts gateway.startAccount
  gateway: {
    startAccount: async (
      ctx: DemoChannelGatewayContext<ResolvedDemoAccount>,
    ): Promise<{ stop: () => void }> => {
      const account = ctx.account;

      ctx.log?.info?.(`starting HTTP server on port ${account.port}`);

      /**
       * HTTP 服务器：接收消息
       *
       * 对应 IRC 的 socket onPrivmsg 事件监听。
       * IRC 原版：client.on("privmsg", ({nick, target, text}) => handleIrcInbound({...}))
       * 本工程：HTTP POST /message → 解析 {from, text} → ctx.onMessage()
       */
      const server = http.createServer(async (req, res) => {
        // 只处理 POST /message
        if (req.method !== "POST" || req.url !== "/message") {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Not found. Use POST /message" }));
          return;
        }

        let body: string;
        try {
          body = await readBody(req);
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Failed to read request body" }));
          return;
        }

        let parsed: { from?: string; text?: string };
        try {
          parsed = JSON.parse(body) as { from?: string; text?: string };
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid JSON" }));
          return;
        }

        const from = parsed.from ?? "anonymous";
        const text = parsed.text ?? "";

        if (!text.trim()) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "text must be non-empty" }));
          return;
        }

        ctx.log?.info?.(`received message from "${from}": ${text}`);

        // 标记响应是否已被 reply 函数发送
        let replied = false;

        /**
         * 发送回复的函数
         *
         * 对应 IRC 的 sendReply 回调（monitor.ts 中注入给 handleIrcInbound）：
         *   IRC: sendReply = async (target, text) => { client.sendPrivmsg(target, text) }
         *   Demo: reply = async (replyText) => { res.end(JSON.stringify({ reply: replyText })) }
         */
        const reply = async (replyText: string): Promise<void> => {
          if (replied) {
            ctx.log?.warn?.("reply() called more than once, ignoring");
            return;
          }
          replied = true;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ reply: replyText }));
          ctx.log?.info?.(`replied to "${from}": ${replyText}`);
        };

        /**
         * 调用 onMessage 回调，将消息传给 Host 层的 agent
         *
         * 对应 IRC inbound.ts 中的 dispatchInboundReplyWithBase() 调用点：
         *   IRC: dispatchInboundReplyWithBase({ cfg, channel, route, deliver: ... })
         *   Demo: ctx.onMessage({ from, text, channel, accountId, reply })
         */
        if (ctx.onMessage) {
          try {
            await ctx.onMessage({
              from,
              text,
              channel: CHANNEL_ID,
              accountId: account.accountId,
              reply,
            });
          } catch (err) {
            ctx.log?.error?.(
              `onMessage handler threw: ${err instanceof Error ? err.message : String(err)}`,
            );
            if (!replied) {
              res.writeHead(500, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "Internal error" }));
            }
          }
        } else {
          // 没有注入 onMessage，说明 Host 没有配置 agent，返回提示
          if (!replied) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ reply: "(no agent configured)" }));
          }
        }

        // 如果 reply 从未被调用（agent 没有调用 reply），返回超时提示
        if (!replied) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ reply: "(no reply)" }));
        }
      });

      // 监听 abort 信号关闭服务器（对应 IRC 的 abortSignal.addEventListener("abort", ...)）
      ctx.abortSignal.addEventListener("abort", () => {
        server.close();
        ctx.log?.info?.("HTTP server closed");
      });

      await new Promise<void>((resolve, reject) => {
        server.on("error", reject);
        server.listen(account.port, () => {
          ctx.log?.info?.(`HTTP server listening on http://localhost:${account.port}/message`);
          resolve();
        });
      });

      return {
        stop: () => server.close(),
      };
    },
  },

  // ─── Outbound 适配器（主动发送消息）────────────────────────────────────
  // 对应 openclaw extensions/irc/src/channel.ts outbound
  // IRC 原版：sendText → sendMessageIrc() → client.sendPrivmsg()
  // Demo：sendText → console.log（模拟主动推送，如 webhook 回调等）
  outbound: {
    deliveryMode: "direct",
    sendText: async ({ to, text, accountId }) => {
      console.log(
        `[demo-channel] outbound send to "${to}" (account: ${accountId ?? "default"}): ${text}`,
      );
      // 在真实实现中，这里会调用 HTTP callback URL 或 WebSocket 推送
      return {
        channel: CHANNEL_ID,
        messageId: `demo-${Date.now()}`,
      };
    },
  },
};
