const CONTROL_UI_LOCALE_BUNDLE_PATTERN = /^ui\/src\/i18n\/locales\/[^/]+\.ts$/u;

/** Returns whether a path is production TypeScript governed by the LOC ratchet. */
export function isProductionTypeScriptFile(filePath) {
  return (
    /\.(?:ts|tsx|mts|cts)$/u.test(filePath) &&
    !CONTROL_UI_LOCALE_BUNDLE_PATTERN.test(filePath) &&
    !/(^|\/)(test|tests|__tests__|test-helpers?|test-support|test-utils?)(\/|$)|\.(test|spec|suite)\.[cm]?tsx?$|(?:^|[/.-])test-(?:helpers?|support|harness)(?:[/.-]|$)/u.test(
      filePath,
    )
  );
}
