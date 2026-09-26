// Android base resources are co-owned: source PRs edit their English content,
// while the generator rewrites managed sections. Treat them as generated only
// alongside a hard-generated artifact so neither ownership path blocks the other.
export const NATIVE_COOWNED_GENERATED_I18N_RE =
  /^apps\/android\/app\/src\/main\/res\/values\/(?:assistant|strings)\.xml$/;
export const NATIVE_HARD_GENERATED_I18N_RE =
  /^(?:apps\/\.i18n\/native\/[^/]+\.json|apps\/android\/app\/src\/main\/java\/ai\/openclaw\/app\/i18n\/NativeStringResources\.kt|apps\/android\/app\/src\/main\/res\/values-[^/]+\/(?:assistant|strings)\.xml|apps\/android\/app\/src\/thirdParty\/res\/values-[^/]+\/accessibility_strings\.xml|apps\/android\/wear\/src\/main\/res\/values-[^/]+\/strings\.xml|apps\/ios\/Resources\/Localizable\.xcstrings|apps\/macos\/Sources\/OpenClaw\/Resources\/Localizable\.xcstrings|apps\/ios\/(?:Sources|WatchApp|ShareExtension|ActivityWidget)\/[^/]+\.lproj\/InfoPlist\.strings)$/;
export const NATIVE_CANONICAL_V2_MIGRATION_GENERATED_RE =
  /^(?:apps\/\.i18n\/native\/[^/]+\.json|apps\/android\/app\/src\/main\/res\/values-[^/]+\/strings\.xml|apps\/android\/wear\/src\/main\/res\/values-[^/]+\/strings\.xml|apps\/ios\/Resources\/Localizable\.xcstrings|apps\/macos\/Sources\/OpenClaw\/Resources\/Localizable\.xcstrings)$/;

/** @param {string[] | null} changedPaths */
export function isNativeGeneratedOnlyChange(changedPaths) {
  return (
    Array.isArray(changedPaths) &&
    changedPaths.some((path) => NATIVE_HARD_GENERATED_I18N_RE.test(path)) &&
    changedPaths.every(
      (path) =>
        NATIVE_HARD_GENERATED_I18N_RE.test(path) || NATIVE_COOWNED_GENERATED_I18N_RE.test(path),
    )
  );
}
