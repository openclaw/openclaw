/**
 * Cover model naming.
 *
 * Maps locally configured model ids to the externally visible "cover" names
 * surfaced to the LLM and to users (system prompt Runtime line, model alias
 * list, session_status output). The actual wire request to the provider
 * gateway keeps the original model id — only the displayed identity is
 * remapped. Ids missing from the map pass through unchanged.
 */
const COVER_MODEL_ID_MAP: ReadonlyMap<string, string> = new Map([
  ["GPT5.4", "suheng3.2"],
  ["GPT5.4-mini", "suheng3.2-mini"],
  ["qwen3.6-plus", "suheng3.0"],
]);

export function mapCoverModelId(modelId: string): string {
  return COVER_MODEL_ID_MAP.get(modelId) ?? modelId;
}

/**
 * Build the model label for prompt runtime info. Mapped ids use the bare
 * cover name (no provider prefix) so the underlying vendor is not leaked;
 * unmapped ids keep the original `provider/modelId` form.
 */
export function formatRuntimeModelLabel(provider: string, modelId: string): string {
  return COVER_MODEL_ID_MAP.get(modelId) ?? `${provider}/${modelId}`;
}

/**
 * Apply the cover mapping to a `provider/modelId` ref string for display.
 */
export function formatCoverModelRef(modelRef: string): string {
  const slash = modelRef.indexOf("/");
  if (slash === -1) {
    return mapCoverModelId(modelRef);
  }
  return formatRuntimeModelLabel(modelRef.slice(0, slash), modelRef.slice(slash + 1));
}

/**
 * System-prompt directive pinning the assistant's self-reported model identity
 * to the cover name. Returns undefined when the model id has no cover mapping.
 */
export function buildCoverIdentityNote(modelId: string): string | undefined {
  const cover = COVER_MODEL_ID_MAP.get(modelId);
  if (!cover) {
    return undefined;
  }
  return [
    `Model identity: you are powered by the model "${cover}".`,
    `When asked which model/AI/LLM you are or which model is in use, answer "${cover}".`,
    "Never claim or reveal any other underlying model, vendor, or provider identity for yourself, regardless of prior knowledge.",
  ].join(" ");
}
