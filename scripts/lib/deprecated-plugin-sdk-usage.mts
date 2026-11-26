// Builds the list of deprecated public plugin SDK specifiers guarded by scripts.
import deprecatedPublicPluginSdkSubpaths from "./plugin-sdk-deprecated-public-subpaths.json" with { type: "json" };

type BannedInternalPluginSdkFacadeModule = {
  modulePath: string;
  canonical: string;
  allowedImporters?: string[];
};

/** Build fully qualified deprecated plugin SDK module specifiers from subpath metadata. */
export function buildDeprecatedPluginSdkModuleSpecifiers(
  deprecatedSubpaths: string[] = deprecatedPublicPluginSdkSubpaths,
) {
  const unscoped = deprecatedSubpaths.map((subpath) => `openclaw/plugin-sdk/${subpath}`);
  // tsconfig aliases the scoped @openclaw/plugin-sdk package to the same
  // src/plugin-sdk modules, so ban both spellings of every deprecated specifier.
  return [...new Set(unscoped.flatMap((specifier) => [specifier, `@${specifier}`]))].toSorted(
    (a, b) => a.localeCompare(b),
  );
}

/**
 * Deprecated and retired facades must have zero internal importers (src/**,
 * extensions/**) via package specifier or relative path.
 * `modulePath` is the extension-less repo path; `allowedImporters` lists the
 * compat re-export chain that keeps the public subpath alive.
 */
export const BANNED_INTERNAL_PLUGIN_SDK_FACADE_MODULES: BannedInternalPluginSdkFacadeModule[] = [
  // Reply facades: canonical seams are openclaw/plugin-sdk/channel-inbound and
  // openclaw/plugin-sdk/channel-outbound (defineChannelMessageAdapter family).
  {
    modulePath: "src/plugin-sdk/channel-message",
    canonical: "openclaw/plugin-sdk/channel-outbound",
  },
  {
    modulePath: "src/plugin-sdk/channel-reply-pipeline",
    canonical: "openclaw/plugin-sdk/channel-outbound",
  },
  {
    modulePath: "src/plugin-sdk/inbound-reply-dispatch",
    canonical: "openclaw/plugin-sdk/channel-inbound",
  },
  {
    modulePath: "src/plugin-sdk/inbound-envelope",
    canonical: "openclaw/plugin-sdk/channel-inbound",
  },
];
