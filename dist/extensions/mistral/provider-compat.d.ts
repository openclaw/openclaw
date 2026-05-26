//#region extensions/mistral/provider-compat.d.ts
declare function contributeMistralResolvedModelCompat(params: {
  modelId: string;
  model: {
    api?: unknown;
    baseUrl?: unknown;
    provider?: unknown;
    compat?: unknown;
  };
}): {
  readonly supportsStore: false;
  readonly maxTokensField: "max_tokens";
} | undefined;
//#endregion
export { contributeMistralResolvedModelCompat };