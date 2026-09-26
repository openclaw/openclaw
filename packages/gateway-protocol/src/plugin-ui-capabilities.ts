/** Static UI contribution kinds, in canonical presentation order. */
export const PLUGIN_UI_CAPABILITIES = [
  "page",
  "navigation",
  "panel",
  "action",
  "accessory",
  "widget",
  "replacement",
  "link-reader",
] as const;

export type PluginUiCapability = (typeof PLUGIN_UI_CAPABILITIES)[number];

/** Omission is unspecified; an empty declaration explicitly advertises no UI. */
export function validatePluginUiCapabilities(
  value: unknown,
): { ok: true; capabilities?: PluginUiCapability[] } | { ok: false; error: string } {
  if (value === undefined) {
    return { ok: true };
  }
  if (!Array.isArray(value)) {
    return { ok: false, error: "must be an array" };
  }
  for (const entry of value) {
    if (!PLUGIN_UI_CAPABILITIES.some((candidate) => candidate === entry)) {
      return { ok: false, error: `contains unknown UI capability ${JSON.stringify(entry)}` };
    }
  }
  return {
    ok: true,
    capabilities: PLUGIN_UI_CAPABILITIES.filter((capability) => value.includes(capability)),
  };
}
