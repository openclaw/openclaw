/**
 * Message processing context, logging tools, and constants
 */

import type { OpenClawConfig, PluginRuntime } from "openclaw/plugin-sdk/core";
import type { YuanbaoWsClient } from "../../access/ws/client.js";
import type { ResolvedYuanbaoAccount } from "../../types.js";

// ============ Message processing context ============

/** Message processing context */
export type MessageHandlerContext = {
  groupCode?: string;
  account: ResolvedYuanbaoAccount;
  config: OpenClawConfig;
  core: PluginRuntime;
  log: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
    verbose: (msg: string) => void;
  };
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
  /** WebSocket 客户端引用，用于发送消息 */
  wsClient: YuanbaoWsClient;
  abortSignal?: AbortSignal;
};

// ============ 常量 ============

/** 防止模型用 markdown 代码块包裹整个回复的系统提示词 */
export const YUANBAO_MARKDOWN_HINT =
  "⚠️ 格式规范（强制）：当回复内容包含 Markdown 表格时，禁止用 ```markdown 代码块包裹，直接输出表格内容即可，不需要外层 fence。";
