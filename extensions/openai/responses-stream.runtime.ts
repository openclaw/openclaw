import { streamSimple } from "openclaw/plugin-sdk/llm";
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import { buildProviderStreamFamilyHooks } from "openclaw/plugin-sdk/provider-stream-family";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { createOpenAINativeWebSearchWrapper } from "./native-web-search.js";
import { TOKEN_SHARING_AUTH_FLOW } from "./token-sharing.js";

const { wrapStreamFn } = buildProviderStreamFamilyHooks("openai-responses-defaults");

export function wrapOpenAIResponsesStream(ctx: ProviderWrapStreamFnContext) {
  if (ctx.auth?.mode === "oauth" && ctx.auth.authFlow === TOKEN_SHARING_AUTH_FLOW) {
    const underlying = ctx.streamFn ?? streamSimple;
    ctx = {
      ...ctx,
      extraParams: {
        ...ctx.extraParams,
        transport: "sse",
        store: false,
        responsesServerCompaction: false,
      },
      streamFn: (model, context, options) =>
        underlying(model, context, {
          ...options,
          transport: "sse",
          replayResponsesItemIds: false,
          onPayload: async (payload, payloadModel) => {
            // Run caller and normal provider transforms first; scoped credential policy wins last.
            const transformed = await options?.onPayload?.(payload, payloadModel);
            const request = asOptionalRecord(transformed ?? payload);
            if (!request) {
              throw new Error("ChatGPT token sharing requires a Responses request object.");
            }
            request.store = false;
            delete request.context_management;
            return request;
          },
        }),
    };
  }
  return createOpenAINativeWebSearchWrapper(wrapStreamFn?.(ctx) ?? ctx.streamFn, {
    config: ctx.config,
    agentId: ctx.agentId,
    nativeWebSearchAllowedByToolPolicy: ctx.nativeWebSearchAllowedByToolPolicy,
  });
}
