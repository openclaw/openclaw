import { resolveDefaultModelForAgent } from "openclaw/plugin-sdk/agent-runtime";
import { resolveEffectiveAgentRuntime } from "openclaw/plugin-sdk/command-auth-native";
import {
  captureSessionEntryCurrentCheck,
  resolveStoredModelOverrideAsync,
} from "openclaw/plugin-sdk/session-binding-runtime";
import { resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { SlackMonitorContext } from "./context.js";

export async function resolveSlackCommandMenuModelContext(params: {
  cfg: SlackMonitorContext["cfg"];
  agentId: string;
  sessionKey: string;
}): Promise<{
  context: { provider?: string; model?: string; agentRuntime?: string };
  assertCurrent: () => void;
}> {
  if (!params.sessionKey.trim()) {
    return { context: {}, assertCurrent() {} };
  }
  const defaultModel = resolveDefaultModelForAgent({ cfg: params.cfg, agentId: params.agentId });
  const storePath = resolveStorePath(params.cfg.session?.store, { agentId: params.agentId });
  const assertions: Array<() => void> = [];
  const readEntry = async (sessionKey: string) => {
    const prepared = await captureSessionEntryCurrentCheck({
      agentId: params.agentId,
      storePath,
      sessionKey,
      fields: [
        "modelOverrideSource",
        "modelOverride",
        "providerOverride",
        "model",
        "modelProvider",
        "modelOverrideRouteResolution",
        "modelOverrideFallbackOriginProvider",
        "modelOverrideFallbackOriginModel",
        "agentHarnessId",
        "agentRuntimeOverride",
      ],
    });
    assertions.push(prepared.assertCurrent);
    return prepared.entry;
  };
  const entry = await readEntry(params.sessionKey);
  let provider: string | undefined;
  let model: string | undefined;
  if (entry?.modelOverrideSource === "auto" && normalizeOptionalString(entry.modelOverride)) {
    provider = defaultModel.provider;
    model = defaultModel.model;
  } else {
    const override = await resolveStoredModelOverrideAsync({
      sessionEntry: entry,
      loadSessionEntry: readEntry,
      sessionKey: params.sessionKey,
      defaultProvider: defaultModel.provider,
    });
    provider = override?.model
      ? override.provider || defaultModel.provider
      : (normalizeOptionalString(entry?.providerOverride) ??
        normalizeOptionalString(entry?.modelProvider));
    model = override?.model
      ? override.model
      : (normalizeOptionalString(entry?.modelOverride) ?? normalizeOptionalString(entry?.model));
  }
  return {
    context: {
      ...(provider ? { provider } : {}),
      ...(model ? { model } : {}),
      agentRuntime: resolveEffectiveAgentRuntime({
        cfg: params.cfg,
        provider: provider ?? defaultModel.provider,
        modelId: model ?? defaultModel.model,
        agentId: params.agentId,
        sessionKey: params.sessionKey,
        sessionEntry: entry,
      }),
    },
    assertCurrent: () => {
      for (const assertCurrent of assertions) {
        assertCurrent();
      }
    },
  };
}
