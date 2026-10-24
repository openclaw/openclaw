import { CONTROL_UI_LOCALE_ENTRIES } from "./control-ui-i18n-config.ts";

// The opaque Mermaid sandbox loads one self-contained classic script only when
// a diagram is viewed. Keep its size visible without relaxing ordinary chunks.
export const MERMAID_RENDERER_ASSET = /^assets\/mermaid\.min-[\w-]+\.js$/u;
// Locale catalogs are named Vite chunks loaded only after a language selection.
// Keep one combined cap for base and on-demand config hints in every locale.
const CONTROL_UI_LOCALE_ASSET_PATTERNS = CONTROL_UI_LOCALE_ENTRIES.flatMap(({ locale }) => [
  {
    locale,
    kind: "base" as const,
    pattern: new RegExp(`^assets/${locale}-[^/]+\\.js$`, "u"),
  },
  {
    locale,
    kind: "configHints" as const,
    pattern: new RegExp(`^assets/locale-config-hints-${locale}-[^/]+\\.js$`, "u"),
  },
]);

export function controlUiLocaleAssetIdentity(
  file: string,
): { locale: string; kind: "base" | "configHints" } | null {
  const match = CONTROL_UI_LOCALE_ASSET_PATTERNS.find(({ pattern }) => pattern.test(file));
  return match ? { locale: match.locale, kind: match.kind } : null;
}

// Foreign namespaces are split independently of the base/config-hint budgets.
const localeNamespacePatterns = CONTROL_UI_LOCALE_ENTRIES.map(
  ({ locale }) => new RegExp(`^assets/locale-namespace-${locale}-[^/]+\\.js$`, "u"),
);

export function isControlUiOptionalAsset(file: string): boolean {
  return (
    MERMAID_RENDERER_ASSET.test(file) ||
    controlUiLocaleAssetIdentity(file) !== null ||
    localeNamespacePatterns.some((pattern) => pattern.test(file))
  );
}
