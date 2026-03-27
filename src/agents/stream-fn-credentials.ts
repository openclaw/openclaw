import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { ModelRegistry } from "@mariozechner/pi-coding-agent";

export function wrapStreamFnWithModelRegistryCredentials(
  streamFn: StreamFn,
  modelRegistry: ModelRegistry,
): StreamFn {
  return async (model, context, options) => {
    const auth = await modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) {
      throw new Error(auth.error);
    }

    return streamFn(model, context, {
      ...options,
      apiKey: auth.apiKey,
      headers:
        auth.headers || options?.headers ? { ...auth.headers, ...options?.headers } : undefined,
    });
  };
}
