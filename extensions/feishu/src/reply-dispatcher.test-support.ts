import { FeishuConfigSchema } from "./config-schema.js";
import type { FeishuConfig } from "./types.js";

export function createReplyAccount(
  renderMode: "auto" | "card",
  streamingMode: "off" | "partial",
  domain: "feishu" | "lark",
  overrides: Partial<FeishuConfig> = {},
) {
  return {
    accountId: "main",
    appId: "app_id",
    appSecret: "app_secret",
    domain,
    config: FeishuConfigSchema.parse({
      renderMode,
      streaming: { mode: streamingMode },
      ...overrides,
    }),
  };
}
