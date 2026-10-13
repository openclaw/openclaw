import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import { createAnthropicThinkingPrefillPayloadWrapper } from "openclaw/plugin-sdk/provider-stream-shared";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";

const log = createSubsystemLogger("cloudflare-ai-gateway-stream");

export function wrapCloudflareAiGatewayProviderStream(
  ctx: ProviderWrapStreamFnContext,
): StreamFn | undefined {
  if (ctx.model?.api !== undefined && ctx.model.api !== "anthropic-messages") {
    return ctx.streamFn;
  }
  return createAnthropicThinkingPrefillPayloadWrapper(ctx.streamFn, (stripped) => {
    log.warn(
      `removed ${stripped} trailing assistant prefill message${stripped === 1 ? "" : "s"} because Anthropic extended thinking requires conversations to end with a user turn`,
    );
  });
}
