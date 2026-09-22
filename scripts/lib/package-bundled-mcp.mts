import { isRecord } from "./record-shared.mjs";

export const PATCHED_MCP_NAME = "chrome-devtools-mcp";
export const PATCHED_MCP_VERSION = "1.8.0";
export const PATCHED_MCP_CLI = "build/src/bin/chrome-devtools-mcp.js";
// pnpm patches installed bytes; npm consumers must receive that same runtime.
const REQUIRED_MCP_FILE_HASHES = new Map([
  [PATCHED_MCP_CLI, "9f380d06e1ac05b257e27e708c0cc4b4ba190e285ed6eb6c8aa50978d98a12c5"],
  [
    "build/src/bin/chrome-devtools-mcp-main.js",
    "fc383cb3e5db5f18cf1e8c49221212c669825248874ba91c90ba9035e175f5b4",
  ],
  ["LICENSE", "58d1e17ffe5109a7ae296caafcadfdbe6a7d176f0bc4ab01e12a689b0499d8bd"],
  [
    "build/src/third_party/THIRD_PARTY_NOTICES",
    "8f10277934fe6888173f41f7cbbd9112d208c8c931bf163db59110f69f119e53",
  ],
  ["build/src/TextSnapshot.js", "299833ad0e4cfc171a417afaec41df594e4862fe53a7ada6ba160409f979788b"],
  ["build/src/McpPage.js", "b9e791d758e4d28589525e2d427600e24b271d365a5879893a392043a11cf426"],
  [
    "build/src/third_party/index.js",
    "a8f5cb1e02405d347117114141b58572f71c083861fb50ab31a27511e3a279bf",
  ],
  [
    "build/src/OPENCLAW_PATCH_NOTICE.md",
    "8f5a32aaedf4bb6f8ad39f226bd343bf804132c11ebc6c3c19f667669856287c",
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
