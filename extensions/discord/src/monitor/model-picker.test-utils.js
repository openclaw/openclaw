function createModelsProviderData(entries, opts) {
  const byProvider = /* @__PURE__ */ new Map();
  for (const [provider, models] of Object.entries(entries)) {
    byProvider.set(provider, new Set(models));
  }
  const providers = Object.keys(entries).toSorted();
  const insertionProvider = Object.keys(entries)[0];
  const defaultProvider = opts?.defaultProviderOrder === "sorted" ? providers[0] ?? "openai" : insertionProvider ?? "openai";
  return {
    byProvider,
    providers,
    resolvedDefault: {
      provider: defaultProvider,
      model: entries[defaultProvider]?.[0] ?? "gpt-4o"
    }
  };
}
export {
  createModelsProviderData
};
