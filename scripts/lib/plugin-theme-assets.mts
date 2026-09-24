import { normalizeManifestThemes } from "../../src/plugins/manifest-themes.ts";

/** Packaging consumes the same declared paths as manifest discovery. */
export function collectPluginThemeAssetPaths(manifest: Record<string, unknown>): string[] {
  if (typeof manifest.id !== "string") {
    return [];
  }
  const normalized = normalizeManifestThemes(manifest.themes, manifest.id);
  if (!normalized.ok) {
    return [];
  }
  const paths = new Set<string>();
  for (const theme of normalized.themes ?? []) {
    paths.add(theme.source);
    for (const source of Object.values(theme.hats ?? {})) {
      paths.add(source);
    }
    for (const critter of Object.values(theme.critters ?? {})) {
      paths.add(critter.source);
    }
  }
  return [...paths];
}
