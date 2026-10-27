export function splitModelRef(raw: string) {
  const [provider, ...model] = raw.split("/");
  return provider && model.length
    ? { provider: provider.toLowerCase(), model: model.join("/") }
    : null;
}

export function normalizeModelRef(raw: string) {
  const split = splitModelRef(raw);
  if (!split) {
    return null;
  }
  return split.provider === "openai" && split.model.toLowerCase() === "alternate-alias"
    ? { provider: "openai", model: "alternate-model" }
    : split;
}
