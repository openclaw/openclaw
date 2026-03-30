import type { StreamFn } from "@mariozechner/pi-agent-core";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { normalizeProviderId } from "openclaw/plugin-sdk/provider-model-shared";
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
const BEDROCK_RUNTIME_REGION_RE = /bedrock-runtime\.([a-z0-9-]+)\.amazonaws\./;

/**
 * Resolve the AWS region for Bedrock API calls.
 * Provider-specific baseUrl wins over global bedrockDiscovery to avoid signing
 * with the wrong region when discovery and provider target different regions.
 */
function resolveBedrockRegion(
  config:
    | { models?: { bedrockDiscovery?: { region?: string }; providers?: Record<string, unknown> } }
    | undefined,
): string | undefined {
  const providerBaseUrl = findProviderBaseUrl(config?.models?.providers);
  return extractRegionFromBaseUrl(providerBaseUrl) ?? config?.models?.bedrockDiscovery?.region;
}

/**
 * Find the baseUrl from the matched provider config entry.
 * Prefers the exact canonical key ("amazon-bedrock") over alias matches ("bedrock")
 * to stay consistent with model resolution, which uses exact-key-first semantics.
 */
function findProviderBaseUrl(providers: Record<string, unknown> | undefined): string | undefined {
  if (!providers) {
    return undefined;
  }
  // Exact canonical key first.
  const exact = (providers[PROVIDER_ID] as { baseUrl?: string } | undefined)?.baseUrl;
  if (exact) {
    return exact;
  }
  // Fall back to alias matches.
  for (const [key, value] of Object.entries(providers)) {
    if (key === PROVIDER_ID || normalizeProviderId(key) !== PROVIDER_ID) {
      continue;
    }
    const baseUrl = (value as { baseUrl?: string }).baseUrl;
    if (baseUrl) {
      return baseUrl;
    }
  }
  return undefined;
}

/** Extract the AWS region from a bedrock-runtime baseUrl, e.g. "https://bedrock-runtime.eu-west-1.amazonaws.com". */
function extractRegionFromBaseUrl(baseUrl: string | undefined): string | undefined {
  if (!baseUrl) {
    return undefined;
  }
  return BEDROCK_RUNTIME_REGION_RE.exec(baseUrl)?.[1];
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
        const region = resolveBedrockRegion(config);

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
