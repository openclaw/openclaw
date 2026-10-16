const OPENCLAW_BUNDLE_PLUGIN_PACKAGES = new Set([
  "@openclaw/acpx",
  "@openclaw/cloudflare",
  "@openclaw/diffs",
  "@openclaw/feishu",
]);

/**
 * @param {string} packageName
 * @returns {"" | "bundle-plugin"}
 */
export function resolveOpenClawClawHubPackageFamily(packageName) {
  return OPENCLAW_BUNDLE_PLUGIN_PACKAGES.has(packageName) ? "bundle-plugin" : "";
}
