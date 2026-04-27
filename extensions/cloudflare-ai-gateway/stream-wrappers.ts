import type { StreamFn } from "@mariozechner/pi-agent-core";
import { createAnthropicThinkingPrefillPayloadWrapper } from "openclaw/plugin-sdk/provider-stream-shared";

export function createCloudflareAiGatewayAnthropicThinkingPrefillWrapper(
  baseStreamFn: StreamFn | undefined,
): StreamFn {
  return createAnthropicThinkingPrefillPayloadWrapper(baseStreamFn);
}
