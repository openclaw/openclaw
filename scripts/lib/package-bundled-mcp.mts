import { isRecord } from "./record-shared.mjs";

export const PATCHED_MCP_NAME = "chrome-devtools-mcp";
export const PATCHED_MCP_VERSION = "1.9.0";
export const PATCHED_MCP_CLI = "build/src/bin/chrome-devtools-mcp.js";
// pnpm patches installed bytes; npm consumers must receive that same runtime.
const REQUIRED_MCP_FILE_HASHES = new Map([
  [PATCHED_MCP_CLI, "9f380d06e1ac05b257e27e708c0cc4b4ba190e285ed6eb6c8aa50978d98a12c5"],
  [
    "build/src/bin/chrome-devtools-mcp-main.js",
    "5ca0e81196ab6b6e1481629a2dcae7f416b3b38f74555e3138ad5cdbb055e809",
  ],
  ["LICENSE", "58d1e17ffe5109a7ae296caafcadfdbe6a7d176f0bc4ab01e12a689b0499d8bd"],
  [
    "build/src/third_party/THIRD_PARTY_NOTICES",
    "975febf536bb1c83c031a7888b90bdf1ffe8dc46000e0698eac364491dca8ac4",
  ],
  ["build/src/TextSnapshot.js", "299833ad0e4cfc171a417afaec41df594e4862fe53a7ada6ba160409f979788b"],
  ["build/src/McpPage.js", "6d83dbd4d79c913664fbfa428d138b22fe4246612ab4dfcd93e9d8e62d5d6b51"],
  [
    "build/src/third_party/index.js",
    "7609bb6c575c7c1152b3f4233ad4b98d97885c62ccff7bd9ee29257ca8ffc83f",
  ],
  [
    "build/src/OPENCLAW_PATCH_NOTICE.md",
    "0e53a04f337a3760f2f1adab9c20e3b4f07019795f503266c0b68e0f46d55a6c",
  ],
]);
const REQUIRED_MCP_FILES = [
  "build/src/third_party/devtools-formatter-worker.js",
  "build/src/third_party/devtools-heap-snapshot-worker.js",
  "build/src/third_party/lighthouse-devtools-mcp-bundle.js",
  "build/src/third_party/bundled-packages.json",
];

/** The published MCP bundles contain optional UMD/BiDi imports; exact patches and assets own their artifact contract. */
export function collectPatchedMcpArtifactErrors({
  manifest,
  files,
  sha256,
}: {
  manifest: unknown;
  files: ReadonlySet<string>;
  sha256: (file: string) => string | undefined;
}): string[] {
  const errors: string[] = [];
  if (
    !isRecord(manifest) ||
    manifest.version !== PATCHED_MCP_VERSION ||
    manifest.type !== "module"
  ) {
    errors.push(`bundled ${PATCHED_MCP_NAME} must be ESM version ${PATCHED_MCP_VERSION}`);
  }
  if (
    !isRecord(manifest) ||
    !isRecord(manifest.bin) ||
    manifest.bin[PATCHED_MCP_NAME] !== `./${PATCHED_MCP_CLI}`
  ) {
    errors.push(`bundled ${PATCHED_MCP_NAME} must expose CLI ${PATCHED_MCP_CLI}`);
  }
  for (const file of [...REQUIRED_MCP_FILES, ...REQUIRED_MCP_FILE_HASHES.keys()]) {
    if (!files.has(file)) {
      errors.push(`bundled ${PATCHED_MCP_NAME} is missing required runtime entry ${file}`);
      continue;
    }
    const expectedHash = REQUIRED_MCP_FILE_HASHES.get(file);
    if (expectedHash && sha256(file) !== expectedHash) {
      errors.push(`bundled ${PATCHED_MCP_NAME} has unpatched or changed runtime entry ${file}`);
    }
  }
  if (
    ![...files].some(
      (entry) =>
        entry.startsWith("build/src/third_party/issue-descriptions/") && entry.endsWith(".md"),
    )
  ) {
    errors.push(`bundled ${PATCHED_MCP_NAME} is missing third-party issue descriptions`);
  }
  return errors;
}
