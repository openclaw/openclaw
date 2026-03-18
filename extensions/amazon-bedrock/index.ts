import type { StreamFn } from "@mariozechner/pi-agent-core";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { normalizeProviderId } from "openclaw/plugin-sdk/provider-models";
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

const PROVIDER_ID = "amazon-bedrock";
const CLAUDE_46_MODEL_RE = /claude-(?:opus|sonnet)-4(?:\.|-)6(?:$|[-.])/i;

/** Extract the AWS region from a bedrock-runtime baseUrl, e.g. "https://bedrock-runtime.eu-west-1.amazonaws.com". */
function extractRegionFromBaseUrl(baseUrl: string | undefined): string | undefined {
  if (!baseUrl) {
    return undefined;
  }
  const match = /bedrock-runtime\.([a-z0-9-]+)\.amazonaws\.com/.exec(baseUrl);
  return match?.[1];
}

export default definePluginEntry({
  id: PROVIDER_ID,
  name: "Amazon Bedrock Provider",
  description: "Bundled Amazon Bedrock provider policy plugin",
  register(api) {
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
      id: PROVIDER_ID,
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
              existing: ctx.config.models?.providers?.[PROVIDER_ID],
              implicit,
            }),
          };
        },
      },
      resolveConfigApiKey: ({ env }) => resolveBedrockConfigApiKey(env),
      capabilities: {
        providerFamily: "anthropic",
        dropThinkingBlockModelHints: ["claude"],
      },
      wrapStreamFn: ({ modelId, config, streamFn }) => {
        // Apply guardrail + base stream wrapping from the pre-built wrapStreamFn.
        const wrapped = wrapStreamFn({ modelId, streamFn });

        // Look up provider baseUrl for region extraction.
        // Use normalized key matching so aliases like "bedrock" / "aws-bedrock" are found.
        let providerBaseUrl: string | undefined;
        const providers = config?.models?.providers;
        if (providers) {
          for (const [key, value] of Object.entries(providers)) {
            if (normalizeProviderId(key) !== PROVIDER_ID) {
              continue;
            }
            const typedValue = value as { baseUrl?: string };
            if (typedValue.baseUrl) {
              providerBaseUrl = typedValue.baseUrl;
              break;
            }
          }
        }

        // Extract region so the pi-ai BedrockRuntimeClient uses the correct endpoint.
        // Provider-specific baseUrl wins over global bedrockDiscovery to avoid signing
        // with the wrong region when discovery and provider target different regions.
        const region =
          extractRegionFromBaseUrl(providerBaseUrl) ?? config?.models?.bedrockDiscovery?.region;

        if (!region) {
          return wrapped;
        }

        // Wrap to inject the region into every stream call.
        const underlying = wrapped ?? streamFn;
        if (!underlying) {
          return wrapped;
        }
        return (model, context, options) => {
          // pi-ai's bedrock provider reads `options.region` at runtime but the
          // StreamFn type does not declare it. Merge via Object.assign to avoid
          // an unsafe type assertion.
          const merged = Object.assign({}, options, { region });
          return underlying(model, context, merged);
        };
      },
      resolveDefaultThinkingLevel: ({ modelId }) =>
        CLAUDE_46_MODEL_RE.test(modelId.trim()) ? "adaptive" : undefined,
    });
  },
});
