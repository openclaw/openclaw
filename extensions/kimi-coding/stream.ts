import type { StreamFn } from "@mariozechner/pi-agent-core";
import { streamSimple } from "@mariozechner/pi-ai";

export function wrapKimiProviderStream(ctx: ProviderWrapStreamFnContext): StreamFn {
  return createKimiToolCallMarkupWrapper(ctx.streamFn);
}
