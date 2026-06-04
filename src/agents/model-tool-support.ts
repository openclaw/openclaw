export function supportsModelTools(model: { provider?: unknown; compat?: unknown }): boolean {
  const compat =
    model.compat && typeof model.compat === "object"
      ? (model.compat as { supportsTools?: boolean })
      : undefined;
  if (compat?.supportsTools === true) {
    return true;
  }
  if (compat?.supportsTools === false) {
    return false;
  }

  const provider = typeof model.provider === "string" ? model.provider.toLowerCase() : "";
  return (
    provider === "openai" ||
    provider === "openai-codex" ||
    provider === "anthropic" ||
    provider === "google"
  );
}
