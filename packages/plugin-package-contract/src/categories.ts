/** Active browse taxonomy, ordered with the core configuration surfaces first. */
export const PLUGIN_CATEGORY_SLUGS = [
  "channels",
  "models",
  "agent-runtimes",
  "memory",
  "context",
  "voice",
  "web",
  "media",
  "security",
  "integrations",
  "developer-tools",
  "infrastructure",
  "documents-files",
  "inbox-collaboration",
  "productivity",
  "scheduling",
  "finance-payments",
  "sales-marketing",
  "data-analytics",
  "agent-orchestration",
  "research",
  "other",
] as const;

/** Published declarations remain readable while authors adopt the active taxonomy. */
const LEGACY_PLUGIN_CATEGORY_SLUGS = ["tools", "runtime", "gateway"] as const;
const ACCEPTED_PLUGIN_CATEGORY_SLUGS = [
  ...PLUGIN_CATEGORY_SLUGS,
  ...LEGACY_PLUGIN_CATEGORY_SLUGS,
] as const;

export type PluginCategorySlug = (typeof ACCEPTED_PLUGIN_CATEGORY_SLUGS)[number];

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
    const category = ACCEPTED_PLUGIN_CATEGORY_SLUGS.find((candidate) => candidate === entry);
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
