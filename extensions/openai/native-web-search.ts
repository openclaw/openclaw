import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createOpenAIHostedWebSearchWrapper } from "openclaw/plugin-sdk/provider-stream-shared";
import { resolveNativeWebSearch } from "./native-web-search-policy.js";

export function createOpenAINativeWebSearchWrapper(
  baseStreamFn: StreamFn | undefined,
  params: {
    config?: OpenClawConfig;
    nativeWebSearchAllowedByToolPolicy?: boolean;
  },
): StreamFn {
  return createOpenAIHostedWebSearchWrapper(
    baseStreamFn,
    ({ model }) =>
      params.nativeWebSearchAllowedByToolPolicy !== false &&
      resolveNativeWebSearch({
        config: params.config,
        provider: model.provider,
        modelId: model.id,
        api: model.api,
        baseUrl: model.baseUrl,
      }),
  );
}
