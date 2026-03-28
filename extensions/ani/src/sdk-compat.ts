import type {
  ChannelAgentTool,
  ChannelOutboundAdapter,
  ChannelPlugin,
  OpenClawPluginApi,
  PluginRuntime,
  RuntimeEnv,
} from "openclaw/plugin-sdk";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);

function loadSdkRuntimeModule<T>(relativeFile: string, fallback = "openclaw/plugin-sdk"): T {
  const rootEntry = require.resolve("openclaw/plugin-sdk");
  const candidate = path.join(path.dirname(rootEntry), relativeFile);
  try {
    return require(candidate) as T;
  } catch {
    return require(fallback) as T;
  }
}

const coreSdk = loadSdkRuntimeModule<{
  DEFAULT_ACCOUNT_ID: string;
  normalizeAccountId: (accountId?: string) => string;
  setAccountEnabledInConfigSection: (...args: any[]) => any;
  deleteAccountFromConfigSection: (...args: any[]) => any;
  applyAccountNameToChannelSection: (...args: any[]) => any;
  buildChannelConfigSchema: (...args: any[]) => any;
  emptyPluginConfigSchema: () => unknown;
}>("core.js");

const channelRuntimeSdk = loadSdkRuntimeModule<{
  createReplyPrefixContext: (...args: any[]) => any;
  createTypingCallbacks: (...args: any[]) => any;
}>("channel-runtime.js");

export const {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  setAccountEnabledInConfigSection,
  deleteAccountFromConfigSection,
  applyAccountNameToChannelSection,
  buildChannelConfigSchema,
  emptyPluginConfigSchema,
} = coreSdk;

export const { createReplyPrefixContext, createTypingCallbacks } = channelRuntimeSdk;

export type {
  ChannelAgentTool,
  ChannelOutboundAdapter,
  ChannelPlugin,
  OpenClawPluginApi,
  PluginRuntime,
  RuntimeEnv,
};
