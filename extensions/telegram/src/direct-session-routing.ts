import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-entry-contract";
import { parseAgentSessionKey } from "openclaw/plugin-sdk/routing";
import {
  resolveTelegramPluginConfig,
  type TelegramPluginConfig,
} from "./direct-session-routing-config.js";

type TelegramDirectSessionContext = {
  channelId?: string;
  sessionKey?: string;
};

type TelegramDirectSessionRoutingResult = {
  providerOverride?: string;
  modelOverride?: string;
};

type TelegramDirectSessionPromptResult = {
  prependSystemContext?: string;
};

function resolveScopedSessionRest(sessionKey: string | undefined): string {
  return parseAgentSessionKey(sessionKey)?.rest ?? "";
}

export function isTelegramDirectSessionContext(params: TelegramDirectSessionContext): boolean {
  const channelId = params.channelId?.trim();
  if (channelId && channelId !== "telegram") {
    return false;
  }

  const scopedRest = resolveScopedSessionRest(params.sessionKey);
  if (!scopedRest) {
    return false;
  }

  return /^telegram(?::[^:]+)?:(?:direct|dm):[^:]+(?::thread:.+)?$/u.test(scopedRest);
}

function isDirectSessionRoutingEnabled(config: TelegramPluginConfig): boolean {
  if (!config.directSessions) {
    return false;
  }
  return config.directSessions.enabled !== false;
}

export function resolveTelegramDirectSessionRouting(params: {
  config: TelegramPluginConfig;
  channelId?: string;
  sessionKey?: string;
}): TelegramDirectSessionRoutingResult | undefined {
  if (!isDirectSessionRoutingEnabled(params.config)) {
    return undefined;
  }
  if (
    !isTelegramDirectSessionContext({
      channelId: params.channelId,
      sessionKey: params.sessionKey,
    })
  ) {
    return undefined;
  }

  const providerOverride = params.config.directSessions?.providerOverride;
  const modelOverride = params.config.directSessions?.modelOverride;
  if (!providerOverride && !modelOverride) {
    return undefined;
  }

  return {
    ...(providerOverride ? { providerOverride } : {}),
    ...(modelOverride ? { modelOverride } : {}),
  };
}

export function resolveTelegramDirectSessionPrompt(params: {
  config: TelegramPluginConfig;
  channelId?: string;
  sessionKey?: string;
}): TelegramDirectSessionPromptResult | undefined {
  if (!isDirectSessionRoutingEnabled(params.config)) {
    return undefined;
  }
  if (
    !isTelegramDirectSessionContext({
      channelId: params.channelId,
      sessionKey: params.sessionKey,
    })
  ) {
    return undefined;
  }

  const prependSystemContext = params.config.directSessions?.prependSystemContext;
  if (!prependSystemContext) {
    return undefined;
  }

  return { prependSystemContext };
}

export function registerTelegramDirectSessionHooks(api: OpenClawPluginApi): void {
  const config = resolveTelegramPluginConfig(api.pluginConfig);
  if (!isDirectSessionRoutingEnabled(config)) {
    return;
  }

  const hasRoutingOverride = Boolean(
    config.directSessions?.providerOverride || config.directSessions?.modelOverride,
  );
  if (hasRoutingOverride) {
    api.on("before_model_resolve", (_event, ctx) =>
      resolveTelegramDirectSessionRouting({
        config,
        channelId: ctx.channelId,
        sessionKey: ctx.sessionKey,
      }),
    );
  }

  if (config.directSessions?.prependSystemContext) {
    api.on("before_prompt_build", (_event, ctx) =>
      resolveTelegramDirectSessionPrompt({
        config,
        channelId: ctx.channelId,
        sessionKey: ctx.sessionKey,
      }),
    );
  }
}
