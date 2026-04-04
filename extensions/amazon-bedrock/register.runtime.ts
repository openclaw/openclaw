import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { buildProviderReplayFamilyHooks } from "openclaw/plugin-sdk/provider-model-shared";
import {
  createBedrockNoCacheWrapper,
  isAnthropicBedrockModel,
  streamWithPayloadPatch,
} from "openclaw/plugin-sdk/provider-stream";
import {
  mergeImplicitBedrockProvider,
  resolveBedrockConfigApiKey,
  resolveImplicitBedrockProvider,
} from "./api.js";

type GuardrailConfig = {
  guardrailIdentifier: string;
  guardrailVersion: string;
  streamProcessingMode?: "sync" | "async";
  trace?: "enabled" | "disabled" | "enabled_full";
};

function createGuardrailWrapStreamFn(
  innerWrapStreamFn: (ctx: { modelId: string; streamFn?: StreamFn }) => StreamFn | null | undefined,
  guardrailConfig: GuardrailConfig,
): (ctx: { modelId: string; streamFn?: StreamFn }) => StreamFn | null | undefined {
  return (ctx) => {
    const inner = innerWrapStreamFn(ctx);
    if (!inner) return inner;
    return (model, context, options) => {
      return streamWithPayloadPatch(inner, model, context, options, (payload) => {
        const gc: Record<string, unknown> = {
          guardrailIdentifier: guardrailConfig.guardrailIdentifier,
          guardrailVersion: guardrailConfig.guardrailVersion,
        };
        if (guardrailConfig.streamProcessingMode) {
          gc.streamProcessingMode = guardrailConfig.streamProcessingMode;
        }
        if (guardrailConfig.trace) {
          gc.trace = guardrailConfig.trace;
        }
        payload.guardrailConfig = gc;
      });
    };
  };
}

export async function registerAmazonBedrockPlugin(api: OpenClawPluginApi): Promise<void> {
  // Keep registration-local constants inside the function so partial module
  // initialization during test bootstrap cannot trip TDZ reads.
  const providerId = "amazon-bedrock";
  const claude46ModelRe = /claude-(?:opus|sonnet)-4(?:\.|-)6(?:$|[-.])/i;
  const anthropicByModelReplayHooks = buildProviderReplayFamilyHooks({
    family: "anthropic-by-model",
  });
  const bedrockContextOverflowPatterns = [
    /ValidationException.*(?:input is too long|max input token|input token.*exceed)/i,
    /ValidationException.*(?:exceeds? the (?:maximum|max) (?:number of )?(?:input )?tokens)/i,
    /ModelStreamErrorException.*(?:Input is too long|too many input tokens)/i,
  ] as const;
  const guardrail = (api.pluginConfig as Record<string, unknown> | undefined)?.guardrail as
    | GuardrailConfig
    | undefined;

  const baseWrapStreamFn = ({ modelId, streamFn }: { modelId: string; streamFn?: StreamFn }) =>
    isAnthropicBedrockModel(modelId) ? streamFn : createBedrockNoCacheWrapper(streamFn);

  const wrapStreamFn =
    guardrail?.guardrailIdentifier && guardrail?.guardrailVersion
      ? createGuardrailWrapStreamFn(baseWrapStreamFn, guardrail)
      : baseWrapStreamFn;

  api.registerProvider({
    id: providerId,
    label: "Amazon Bedrock",
    docsPath: "/providers/models",
    auth: [],
    catalog: {
      order: "simple",
      run: async (ctx) => {
        const implicit = await resolveImplicitBedrockProvider({
          config: ctx.config,
          env: ctx.env,
        });
        if (!implicit) {
          return null;
        }
        return {
          provider: mergeImplicitBedrockProvider({
            existing: ctx.config.models?.providers?.[providerId],
            implicit,
          }),
        };
      },
    },
    resolveConfigApiKey: ({ env }) => resolveBedrockConfigApiKey(env),
    ...anthropicByModelReplayHooks,
    wrapStreamFn,
    matchesContextOverflowError: ({ errorMessage }) =>
      bedrockContextOverflowPatterns.some((pattern) => pattern.test(errorMessage)),
    classifyFailoverReason: ({ errorMessage }) => {
      if (/ThrottlingException|Too many concurrent requests/i.test(errorMessage)) {
        return "rate_limit";
      }
      if (/ModelNotReadyException/i.test(errorMessage)) {
        return "overloaded";
      }
      return undefined;
    },
    resolveDefaultThinkingLevel: ({ modelId }) =>
      claude46ModelRe.test(modelId.trim()) ? "adaptive" : undefined,
  });
}
