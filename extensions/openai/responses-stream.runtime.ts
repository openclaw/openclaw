import { streamSimple, type SimpleStreamOptions } from "openclaw/plugin-sdk/llm";
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import { buildProviderStreamFamilyHooks } from "openclaw/plugin-sdk/provider-stream-family";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { createOpenAINativeWebSearchWrapper } from "./native-web-search.js";
import { TOKEN_SHARING_AUTH_FLOW } from "./token-sharing.js";

const { wrapStreamFn } = buildProviderStreamFamilyHooks("openai-responses-defaults");
const SIWC_SERVICE_TIERS = ["default", "priority", "ultrafast", "slow"];

export function wrapOpenAIResponsesStream(ctx: ProviderWrapStreamFnContext) {
  let streamContext = ctx;
  if (ctx.auth?.mode === "oauth" && ctx.auth.authFlow === TOKEN_SHARING_AUTH_FLOW) {
    const underlying = ctx.streamFn ?? streamSimple;
    streamContext = {
      ...ctx,
      extraParams: {
        ...ctx.extraParams,
        transport: "sse",
        responsesServerCompaction: false,
      },
      streamFn: (model, context, options) => {
        const headers = new Headers(options?.headers);
        // Required by the OSS preview; remove when OpenAI retires this header.
        headers.set("x-openai-chatpass-test", "codex-direct");
        // Shared provider policy can enable item references. This grant requires
        // complete-context replay before request payload transforms run.
        const sharingOptions: SimpleStreamOptions & { replayResponsesItemIds: false } = {
          ...options,
          headers: Object.fromEntries(headers.entries()),
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
  return createOpenAINativeWebSearchWrapper(
    wrapStreamFn?.(streamContext) ?? streamContext.streamFn,
    {
      config: ctx.config,
      agentId: ctx.agentId,
      nativeWebSearchAllowedByToolPolicy: ctx.nativeWebSearchAllowedByToolPolicy,
    },
  );
}
