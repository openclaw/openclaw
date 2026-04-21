/**
 * Message processing context, logging tools, and constants
 */

import type { OpenClawConfig, PluginRuntime } from "openclaw/plugin-sdk/core";
import type { YuanbaoWsClient } from "../../access/ws/client.js";
import type { ResolvedYuanbaoAccount } from "../../types.js";

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
  wsClient: YuanbaoWsClient;
  abortSignal?: AbortSignal;
};

/** System prompt to prevent model from wrapping entire reply in markdown code block */
export const YUANBAO_MARKDOWN_HINT =
  "⚠️ 格式规范（强制）：当回复内容包含 Markdown 表格时，禁止用 ```markdown 代码块包裹，直接输出表格内容即可，不需要外层 fence。";
