import { resolveMarkdownTableMode } from "openclaw/plugin-sdk/markdown-table-runtime";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  chunkMarkdownTextWithMode,
  chunkTextWithMode,
  resolveChunkMode,
  resolveTextChunkLimit,
} from "openclaw/plugin-sdk/reply-chunking";
import { createPluginRuntimeStore, type PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import { convertMarkdownTables } from "openclaw/plugin-sdk/text-chunking";
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

export function installReplyRuntime(fullChunking = false) {
  const store = createPluginRuntimeStore<PluginRuntime>({
    pluginId: "feishu",
    errorMessage: "Feishu runtime not initialized",
  });
  const previous = store.tryGetRuntime();
  const runtime = createPluginRuntimeMock();
  Object.assign(runtime.channel.text, {
    resolveTextChunkLimit,
    resolveChunkMode,
    chunkMarkdownTextWithMode,
    convertMarkdownTables,
    resolveMarkdownTableMode: () => "preserve",
    ...(fullChunking ? { chunkTextWithMode, resolveMarkdownTableMode } : {}),
  });
  store.setRuntime(runtime);
  return () => {
    if (previous) {
      store.setRuntime(previous);
    } else {
      store.clearRuntime();
    }
  };
}
