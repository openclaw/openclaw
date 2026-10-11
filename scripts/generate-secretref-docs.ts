#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeBundledChannelConfigMetadataModule } from "./generate-bundled-channel-config-metadata.js";
import { readSecretRefDocsFile, writeSecretRefDocsFile } from "./lib/secretref-docs-file.js";

const args = new Set(process.argv.slice(2));
const check = args.has("--check");
const write = args.has("--write");
if (check === write || args.size !== 1) {
  console.error("Usage: node --import tsx scripts/generate-secretref-docs.ts --check|--write");
  process.exit(1);
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const metadataResults = await writeBundledChannelConfigMetadataModule(check, { repoRoot });
const changedMetadata = metadataResults.filter((result) => result.changed);
if (check && changedMetadata.length > 0) {
  for (const result of changedMetadata) {
    console.error(`SecretRef docs input drift: ${path.relative(repoRoot, result.outputPath)}`);
  }
  console.error("Run `pnpm config:channels:gen` and commit the generated changes.");
  process.exit(1);
}

const sourceModuleUrl = (fileName: string): string =>
  pathToFileURL(path.join(repoRoot, "src/secrets", fileName)).href;
const [matrixDocs, credentialMatrix, targetRegistry] = (await Promise.all([
  import(sourceModuleUrl("credential-matrix-docs.ts")),
  import(sourceModuleUrl("credential-matrix.ts")),
  import(sourceModuleUrl("target-registry-data.ts")),
])) as [
  {
    renderSecretRefCredentialMatrixJson: (matrix: unknown) => string;
    renderSecretRefCredentialSurface: (currentSurface: string, matrix: unknown) => string;
  },
  { buildSecretRefCredentialMatrix: (registry: unknown) => unknown },
  {
    getSecretTargetRegistry: (options: {
      sourceTree: boolean;
      sourceTreeRoot: string;
      env: NodeJS.ProcessEnv;
    }) => unknown;
  },
];

const matrixPath = path.join(
  repoRoot,
  "docs/reference/secretref-user-supplied-credentials-matrix.json",
);
const surfacePath = path.join(repoRoot, "docs/reference/secretref-credential-surface.md");
const currentSurface = readSecretRefDocsFile(repoRoot, surfacePath);
const registry = targetRegistry.getSecretTargetRegistry({
  sourceTree: true,
  sourceTreeRoot: path.join(repoRoot, "extensions"),
  env: {},
});
const matrix = credentialMatrix.buildSecretRefCredentialMatrix(registry);
const artifacts = [
  {
    path: matrixPath,
    current: readSecretRefDocsFile(repoRoot, matrixPath),
    expected: matrixDocs.renderSecretRefCredentialMatrixJson(matrix),
  },
  {
    path: surfacePath,
    current: currentSurface,
    expected: matrixDocs.renderSecretRefCredentialSurface(currentSurface, matrix),
  },
];

const changed = artifacts.filter((artifact) => artifact.current !== artifact.expected);
if (check) {
  if (changed.length === 0) {
    console.log("SecretRef reference docs are up to date.");
    process.exit(0);
  }
  for (const artifact of changed) {
    console.error(`SecretRef docs drift: ${path.relative(repoRoot, artifact.path)}`);
  }
  console.error("Run `pnpm gen:secretref-docs` and commit the generated changes.");
  process.exit(1);
}

for (const artifact of changed) {
  await writeSecretRefDocsFile(repoRoot, artifact.path, artifact.expected);
  console.log(`Wrote ${path.relative(repoRoot, artifact.path)}`);
}
if (changed.length === 0) {
  console.log("SecretRef reference docs are already up to date.");
}
