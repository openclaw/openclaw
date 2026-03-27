import type { StreamFn } from "@mariozechner/pi-agent-core";

type RequestAuthResult =
  | {
      ok: true;
      apiKey?: string;
      headers?: Record<string, string>;
    }
  | {
      ok: false;
      error: string;
    };

type RequestAuthModelRegistry = {
  getApiKeyAndHeaders(model: Parameters<StreamFn>[0]): Promise<RequestAuthResult>;
};

export function createAuthenticatedStreamFn(
  baseStreamFn: StreamFn,
  modelRegistry: RequestAuthModelRegistry,
): StreamFn {
  return async (model, context, options) => {
    const auth = await modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) {
      throw new Error(auth.error);
    }
    return baseStreamFn(model, context, {
      ...options,
      apiKey: auth.apiKey,
      headers:
        auth.headers || options?.headers
          ? {
              ...auth.headers,
              ...options?.headers,
            }
          : undefined,
    });
  };
}
