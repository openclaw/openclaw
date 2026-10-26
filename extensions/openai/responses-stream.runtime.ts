import { streamSimple, type SimpleStreamOptions } from "openclaw/plugin-sdk/llm";
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import { buildProviderStreamFamilyHooks } from "openclaw/plugin-sdk/provider-stream-family";
import {
  createOpenAIHostedWebSearchWrapper,
  mergeTransportHeaders,
} from "openclaw/plugin-sdk/provider-stream-shared";
import { asOptionalRecord, normalizeFastMode } from "openclaw/plugin-sdk/string-coerce-runtime";
import { classifyOpenAIBaseUrl } from "./base-url.js";
import { resolveNativeWebSearch } from "./native-web-search-policy.js";
import { resolveOpenAIModelServiceTiers } from "./service-tier-policy.js";
import { TOKEN_SHARING_AUTH_FLOW } from "./token-sharing.js";

const { wrapStreamFn } = buildProviderStreamFamilyHooks("openai-responses-defaults");
const SIWC_SERVICE_TIERS = ["default", "priority", "ultrafast", "slow"];

export function wrapOpenAIResponsesStream(ctx: ProviderWrapStreamFnContext) {
  let streamContext = ctx;
  const serviceTiers = ctx.model
    ? resolveOpenAIModelServiceTiers({
        modelId: ctx.model.id,
        api: ctx.model.api,
        baseUrl: ctx.model.baseUrl,
      })
    : undefined;
  if (serviceTiers) {
    // Resolve each call so timed Auto still expires; explicit API tiers remain operator-owned.
    streamContext = {
      ...ctx,
      extraParams: {
        ...ctx.extraParams,
        fastMode: () => {
          const raw = ctx.extraParams?.fastMode ?? ctx.extraParams?.fast_mode;
          const requested = normalizeFastMode(typeof raw === "function" ? raw() : raw);
          if (requested === undefined) {
            return undefined;
          }
          if (!serviceTiers.includes("priority")) {
            return false;
          }
          return requested === "ultrafast" ? true : requested;
        },
      },
    };
  }
  const configuredAccessPrograms = ctx.extraParams?.accessPrograms;
  if (configuredAccessPrograms !== undefined) {
    const accessPrograms = asOptionalRecord(configuredAccessPrograms);
    const cyber = accessPrograms?.cyber;
    if (
      !accessPrograms ||
      Object.keys(accessPrograms).some((key) => key !== "cyber") ||
      (cyber !== undefined &&
        !["standard", "daybreak_blue", "daybreak_red"].some((value) => value === cyber))
    ) {
      throw new Error(
        'OpenAI params.accessPrograms must be {} or { cyber: "standard" | "daybreak_blue" | "daybreak_red" }.',
      );
    }
    const underlying = streamContext.streamFn ?? streamSimple;
    streamContext = {
      ...streamContext,
      streamFn: (model, context, options) => {
        if (
          !(
            (model.api === "openai-responses" &&
              classifyOpenAIBaseUrl(model.baseUrl) === "platform") ||
            (model.api === "openai-chatgpt-responses" &&
              classifyOpenAIBaseUrl(model.baseUrl) === "chatgpt")
          )
        ) {
          throw new Error(
            "OpenAI params.accessPrograms requires an official OpenAI Platform or ChatGPT Responses endpoint.",
          );
        }
        return underlying(model, context, {
          ...options,
          onPayload: async (payload, payloadModel) => {
            const transformed = await options?.onPayload?.(payload, payloadModel);
            const request = asOptionalRecord(transformed ?? payload);
            if (!request) {
              throw new Error("OpenAI access programs require a Responses request object.");
            }
            // Program selection and speed are independent; neither grants account access.
            return { ...request, access_programs: cyber === undefined ? {} : { cyber } };
          },
        });
      },
    };
  }
  if (ctx.auth?.mode === "oauth" && ctx.auth.authFlow === TOKEN_SHARING_AUTH_FLOW) {
    const underlying = streamContext.streamFn ?? streamSimple;
    streamContext = {
      ...streamContext,
      extraParams: {
        ...streamContext.extraParams,
        transport: "sse",
        responsesServerCompaction: false,
      },
      streamFn: (model, context, options) => {
        // Required by the OSS preview; remove when OpenAI retires this header.
        // Shared provider policy can enable item references. This grant requires
        // complete-context replay before request payload transforms run.
        const sharingOptions: SimpleStreamOptions & { replayResponsesItemIds: false } = {
          ...options,
          headers: mergeTransportHeaders(options?.headers, {
            "x-openai-chatpass-test": "codex-direct",
          }),
          transport: "sse",
          replayResponsesItemIds: false,
          onPayload: async (payload, payloadModel) => {
            // Run caller and normal provider transforms first; scoped credential policy wins last.
            const transformed = await options?.onPayload?.(payload, payloadModel);
            const request = asOptionalRecord(transformed ?? payload);
            if (!request) {
              throw new Error("ChatGPT token sharing requires a Responses request object.");
            }
            if (
              request.service_tier != null &&
              !SIWC_SERVICE_TIERS.some((tier) => tier === request.service_tier)
            ) {
              throw new Error(
                "Sign in with ChatGPT does not support this service tier. " +
                  `Remove serviceTier/service_tier from the model params or select one of: ${SIWC_SERVICE_TIERS.join(", ")}.`,
              );
            }
            request.store = false;
            // Direct SIWC rejects these API request controls, including the model's default token cap.
            for (const field of [
              "context_management",
              "metadata",
              "max_output_tokens",
              "temperature",
              "top_p",
              "prompt_cache_retention",
            ]) {
              delete request[field];
            }
            return request;
          },
        };
        return underlying(model, context, sharingOptions);
      },
    };
  }
  const baseStreamFn = wrapStreamFn?.(streamContext) ?? streamContext.streamFn;
  const config = ctx.config;
  const nativeWebSearchAllowedByToolPolicy = ctx.nativeWebSearchAllowedByToolPolicy;
  return createOpenAIHostedWebSearchWrapper(
    baseStreamFn,
    ({ model }) =>
      nativeWebSearchAllowedByToolPolicy !== false &&
      resolveNativeWebSearch({
        config,
        provider: model.provider,
        modelId: model.id,
        api: model.api,
        baseUrl: model.baseUrl,
      }),
  );
}
