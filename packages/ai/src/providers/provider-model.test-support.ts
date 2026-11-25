import type { Api, Model } from "../types.js";

export function makeProviderModel<A extends Api>(
  api: A,
  provider: string,
  id: string,
  options: Partial<Model<A>> = {},
): Model<A> {
  return {
    api,
    provider,
    id,
    name: id,
    baseUrl: "https://example.invalid",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8192,
    ...options,
  };
}
