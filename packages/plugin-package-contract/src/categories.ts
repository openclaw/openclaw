// Keep category validation dependency-free: native Node packaging and updater
// entrypoints consume it before any runtime source has been compiled.

/** Controlled browse categories accepted by native OpenClaw plugin manifests. */
export const PLUGIN_CATEGORY_SLUGS = [
  "channels",
  "models",
  "memory",
  "context",
  "voice",
  "media",
  "web",
  "tools",
  "runtime",
  "gateway",
  "security",
  "other",
] as const;

export type PluginCategorySlug = (typeof PLUGIN_CATEGORY_SLUGS)[number];

export type PluginCategoriesValidationResult =
  | { ok: true; categories?: PluginCategorySlug[] }
  | { ok: false; error: string };

/** Validate optional ordered package-owned plugin categories. */
export function validatePluginCategories(value: unknown): PluginCategoriesValidationResult {
  if (value === undefined) {
    return { ok: true };
  }
  if (!Array.isArray(value)) {
    return { ok: false, error: "must be an array" };
  }
  if (value.length < 1 || value.length > 3) {
    return { ok: false, error: "must contain between 1 and 3 entries" };
  }
  const categories: PluginCategorySlug[] = [];
  for (const entry of value) {
    const category = PLUGIN_CATEGORY_SLUGS.find((candidate) => candidate === entry);
    if (!category) {
      return { ok: false, error: `contains unknown category ${JSON.stringify(entry)}` };
    }
    if (categories.includes(category)) {
      return { ok: false, error: "must not contain duplicates" };
    }
    categories.push(category);
  }
  return { ok: true, categories };
}
