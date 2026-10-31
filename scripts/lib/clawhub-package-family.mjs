const OPENCLAW_NATIVE_PLUGIN_PACKAGES = new Set([
  "@openclaw/acpx",
  "@openclaw/cloudflare",
  "@openclaw/diffs",
  "@openclaw/feishu",
]);

/**
 * @param {string} packageName
 * @returns {"" | "code-plugin"}
 */
export function resolveOpenClawClawHubPackageFamily(packageName) {
  return OPENCLAW_NATIVE_PLUGIN_PACKAGES.has(packageName) ? "code-plugin" : "";
}
