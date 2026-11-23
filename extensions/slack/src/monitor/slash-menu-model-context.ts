import { resolveDefaultModelForAgent } from "openclaw/plugin-sdk/agent-runtime";
import {
  resolveEffectiveAgentRuntime,
  resolveStoredModelOverrideAsync,
} from "openclaw/plugin-sdk/command-auth-native";
import { getSessionEntryAsync, resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { SlackMonitorContext } from "./context.js";

export async function resolveSlackCommandMenuModelContext(params: {
  cfg: SlackMonitorContext["cfg"];
  agentId: string;
  sessionKey: string;
}): Promise<{ provider?: string; model?: string; agentRuntime?: string }> {
  if (!params.sessionKey.trim()) {
    return {};
  }
  try {
    const defaultModel = resolveDefaultModelForAgent({
      cfg: params.cfg,
      agentId: params.agentId,
    });
    const storePath = resolveStorePath(params.cfg.session?.store, { agentId: params.agentId });
    const entry = await getSessionEntryAsync({
      agentId: params.agentId,
      storePath,
      sessionKey: params.sessionKey,
    });
    let provider: string | undefined;
    let model: string | undefined;
    if (entry?.modelOverrideSource === "auto" && normalizeOptionalString(entry.modelOverride)) {
      provider = defaultModel?.provider;
      model = defaultModel?.model;
    } else {
      const override = await resolveStoredModelOverrideAsync({
        sessionEntry: entry,
        sessionKey: params.sessionKey,
        defaultProvider: defaultModel?.provider,
        loadSessionEntry: (sessionKey) =>
          getSessionEntryAsync({ agentId: params.agentId, storePath, sessionKey }),
      });
      provider = override?.model
        ? override.provider || defaultModel?.provider
        : (normalizeOptionalString(entry?.providerOverride) ??
          normalizeOptionalString(entry?.modelProvider));
      model = override?.model
        ? override.model
        : (normalizeOptionalString(entry?.modelOverride) ?? normalizeOptionalString(entry?.model));
    }
    const runtimeProvider = provider ?? defaultModel?.provider;
    const runtimeModel = model ?? defaultModel?.model;
    if (!runtimeProvider || !runtimeModel) {
      // No model selected or configured: the runtime is unknown until one is chosen.
      return { ...(provider ? { provider } : {}), ...(model ? { model } : {}) };
    }
    return {
      ...(provider ? { provider } : {}),
      ...(model ? { model } : {}),
      agentRuntime: resolveEffectiveAgentRuntime({
        cfg: params.cfg,
        provider: runtimeProvider,
        modelId: runtimeModel,
        agentId: params.agentId,
        sessionKey: params.sessionKey,
        sessionEntry: entry,
      }),
    };
  } catch {
    return {};
  }
}
