import { isRecord } from "./record-shared.mjs";

export const PATCHED_MCP_NAME = "chrome-devtools-mcp";
export const PATCHED_MCP_CLI = "build/src/bin/chrome-devtools-mcp.js";
// pnpm patches installed bytes; npm consumers must receive that same runtime.
// Trusted tooling also qualifies frozen targets. Retain the exact 1.8.0 contract
// shipped in v2026.9.6 (eb377ac59e6c9fd6c7705028034812becf00271b) until supported
// release targets no longer pin it; a dependency refresh is not its retirement.
// Never derive expected hashes from the artifact being checked.
const MCP_FILE_HASHES = new Map<string, ReadonlyMap<string, string>>([
  [
    "1.8.0",
    new Map([
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
      [
        "build/src/TextSnapshot.js",
        "299833ad0e4cfc171a417afaec41df594e4862fe53a7ada6ba160409f979788b",
      ],
      ["build/src/McpPage.js", "b9e791d758e4d28589525e2d427600e24b271d365a5879893a392043a11cf426"],
      [
        "build/src/third_party/index.js",
        "a8f5cb1e02405d347117114141b58572f71c083861fb50ab31a27511e3a279bf",
      ],
      [
        "build/src/OPENCLAW_PATCH_NOTICE.md",
        "8f5a32aaedf4bb6f8ad39f226bd343bf804132c11ebc6c3c19f667669856287c",
      ],
    ]),
  ],
  [
    "1.9.0",
    new Map([
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
      [
        "build/src/TextSnapshot.js",
        "299833ad0e4cfc171a417afaec41df594e4862fe53a7ada6ba160409f979788b",
      ],
      ["build/src/McpPage.js", "6d83dbd4d79c913664fbfa428d138b22fe4246612ab4dfcd93e9d8e62d5d6b51"],
      [
        "build/src/third_party/index.js",
        "7609bb6c575c7c1152b3f4233ad4b98d97885c62ccff7bd9ee29257ca8ffc83f",
      ],
      [
        "build/src/OPENCLAW_PATCH_NOTICE.md",
        "0e53a04f337a3760f2f1adab9c20e3b4f07019795f503266c0b68e0f46d55a6c",
      ],
    ]),
  ],
]);
const REQUIRED_MCP_FILES = [
  "build/src/third_party/devtools-formatter-worker.js",
  "build/src/third_party/devtools-heap-snapshot-worker.js",
  "build/src/third_party/lighthouse-devtools-mcp-bundle.js",
  "build/src/third_party/bundled-packages.json",
];

export function isSupportedPatchedMcpVersion(version: unknown): version is string {
  return typeof version === "string" && MCP_FILE_HASHES.has(version);
}

/** The published MCP bundles contain optional UMD/BiDi imports; exact patches and assets own their artifact contract. */
export function collectPatchedMcpArtifactErrors({
  // The node-bootstrap producer checks the current runtime; frozen package
  // consumers pass their independently checked exact dependency pin.
  declaredVersion = "1.9.0",
  manifest,
  files,
  sha256,
}: {
  declaredVersion?: unknown;
  manifest: unknown;
  files: ReadonlySet<string>;
  sha256: (file: string) => string | undefined;
}): string[] {
  const hashes =
    typeof declaredVersion === "string" ? MCP_FILE_HASHES.get(declaredVersion) : undefined;
  if (typeof declaredVersion !== "string" || !hashes) {
    return [
      `package.json dependencies.${PATCHED_MCP_NAME} must be pinned to a supported patched version`,
    ];
  }
  const errors: string[] = [];
  if (!isRecord(manifest) || manifest.version !== declaredVersion || manifest.type !== "module") {
    errors.push(`bundled ${PATCHED_MCP_NAME} must be ESM version ${declaredVersion}`);
  }
  if (
    !isRecord(manifest) ||
    !isRecord(manifest.bin) ||
    manifest.bin[PATCHED_MCP_NAME] !== `./${PATCHED_MCP_CLI}`
  ) {
    errors.push(`bundled ${PATCHED_MCP_NAME} must expose CLI ${PATCHED_MCP_CLI}`);
  }
  for (const file of [...REQUIRED_MCP_FILES, ...hashes.keys()]) {
    if (!files.has(file)) {
      errors.push(`bundled ${PATCHED_MCP_NAME} is missing required runtime entry ${file}`);
      continue;
    }
    const expectedHash = hashes.get(file);
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
