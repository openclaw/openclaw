import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import { buildProviderStreamFamilyHooks } from "openclaw/plugin-sdk/provider-stream-family";

const responses = buildProviderStreamFamilyHooks("opencode-responses");

export function wrapOpencodeProviderStream(ctx: ProviderWrapStreamFnContext): StreamFn {
  return responses.wrapStreamFn!(ctx)!;
}
