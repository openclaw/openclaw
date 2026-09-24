import type {
  OpenClawConfig,
  ProviderAppGuidedSetupContext,
  ProviderAuthContext,
  ProviderAuthMethodNonInteractiveContext,
  ProviderAuthResult,
} from "openclaw/plugin-sdk/plugin-entry";
import { ensureModelAllowlistEntry } from "openclaw/plugin-sdk/provider-onboard";
import {
  APPLE_FM_MIN_CONTEXT_WINDOW,
  APPLE_FM_MODEL_REF,
  APPLE_FM_PROVIDER_ID,
  buildAppleFmProviderConfig,
} from "./defaults.js";
import type { AppleFmFacts, AppleFmNative } from "./native.js";

const SETUP_NOTE =
  "Apple Foundation Models is your on-device setup and utility model, with no API key. " +
  "Choose a separate primary model for regular agent conversations.";

function requireUsableModel(facts: AppleFmFacts): void {
  if (!facts.available) {
    throw new Error(
      facts.reason ||
        "Apple Foundation Models is unavailable. Enable Apple Intelligence in System Settings and wait for its model download, then retry setup.",
    );
  }
  if (facts.contextWindow < APPLE_FM_MIN_CONTEXT_WINDOW) {
    throw new Error(
      `${facts.modelName} provides ${facts.contextWindow} context tokens. ` +
        `OpenClaw's Apple setup option requires at least ${APPLE_FM_MIN_CONTEXT_WINDOW}. ` +
        "Choose another local or cloud model on this Mac.",
    );
  }
}

function setupResult(facts: AppleFmFacts): ProviderAuthResult {
  requireUsableModel(facts);
  return {
    profiles: [],
    defaultModel: APPLE_FM_MODEL_REF,
    notes: [SETUP_NOTE],
    configPatch: {
      models: { providers: { [APPLE_FM_PROVIDER_ID]: buildAppleFmProviderConfig(facts) } },
      agents: {
        defaults: {
          models: { [APPLE_FM_MODEL_REF]: { agentRuntime: { id: "openclaw" } } },
        },
      },
    },
  };
}

export async function detectAppleFmSetup(
  ctx: ProviderAppGuidedSetupContext,
  native: AppleFmNative,
) {
  const facts = await native.probe({ signal: ctx.signal, env: ctx.env });
  if (!facts?.available || facts.contextWindow < APPLE_FM_MIN_CONTEXT_WINDOW) {
    return null;
  }
  return {
    modelRef: APPLE_FM_MODEL_REF,
    detail: `${facts.modelName} · ${facts.contextWindow.toLocaleString("en-US")} tokens · on-device setup and utility`,
  };
}

export async function prepareAppleFmSetup(
  ctx: ProviderAppGuidedSetupContext & { modelRef: string },
  native: AppleFmNative,
): Promise<ProviderAuthResult | null> {
  if (ctx.modelRef !== APPLE_FM_MODEL_REF) {
    return null;
  }
  return setupResult(await native.prepare({ signal: ctx.signal, env: ctx.env }));
}

export async function runAppleFmSetup(
  ctx: ProviderAuthContext,
  native: AppleFmNative,
): Promise<ProviderAuthResult> {
  return setupResult(await native.prepare({ signal: ctx.signal, env: ctx.env }));
}

export async function validateAppleFmNonInteractive(
  ctx: Pick<ProviderAuthMethodNonInteractiveContext, "runtime">,
  native: AppleFmNative,
): Promise<boolean> {
  const facts = await native.probe();
  if (!facts) {
    ctx.runtime.error(
      "Apple Foundation Models requires an Apple Silicon Mac running macOS 27 or later.",
    );
    return false;
  }
  try {
    requireUsableModel(facts);
    return true;
  } catch (error) {
    ctx.runtime.error(error instanceof Error ? error.message : String(error));
    return false;
  }
}

export async function configureAppleFmNonInteractive(
  ctx: ProviderAuthMethodNonInteractiveContext,
  native: AppleFmNative,
): Promise<OpenClawConfig> {
  const facts = await native.prepare();
  requireUsableModel(facts);
  return ensureModelAllowlistEntry({
    cfg: {
      ...ctx.config,
      models: {
        ...ctx.config.models,
        providers: {
          ...ctx.config.models?.providers,
          [APPLE_FM_PROVIDER_ID]: buildAppleFmProviderConfig(facts),
        },
      },
      agents: {
        ...ctx.config.agents,
        defaults: {
          ...ctx.config.agents?.defaults,
          utilityModel: APPLE_FM_MODEL_REF,
          models: {
            ...ctx.config.agents?.defaults?.models,
            [APPLE_FM_MODEL_REF]: {
              ...ctx.config.agents?.defaults?.models?.[APPLE_FM_MODEL_REF],
              agentRuntime: { id: "openclaw" },
            },
          },
        },
      },
    },
    modelRef: APPLE_FM_MODEL_REF,
  });
}
