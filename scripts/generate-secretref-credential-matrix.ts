import fs from "node:fs";
import path from "node:path";
import {
  formatSecretRefSupportedListMarkdown,
  formatSecretRefUnsupportedListMarkdown,
  replaceMarkedBlock,
} from "../src/secrets/credential-matrix-docs.js";
import { buildSecretRefCredentialMatrix } from "../src/secrets/credential-matrix.js";

const repoRoot = process.cwd();
const matrixPath = path.join(
  repoRoot,
  "docs",
  "reference",
  "secretref-user-supplied-credentials-matrix.json",
);
const surfacePath = path.join(repoRoot, "docs", "reference", "secretref-credential-surface.md");

const matrix = buildSecretRefCredentialMatrix();
const expectedMatrixJson = `${JSON.stringify(matrix, null, 2)}\n`;

const expectedSupportedBlock = formatSecretRefSupportedListMarkdown(matrix);
const expectedUnsupportedBlock = formatSecretRefUnsupportedListMarkdown(matrix);

function rebuildSurface(currentSurface: string): string {
  let next = replaceMarkedBlock(currentSurface, {
    startMarker: '[//]: # "secretref-supported-list-start"',
    endMarker: '[//]: # "secretref-supported-list-end"',
    body: expectedSupportedBlock,
  });
  next = replaceMarkedBlock(next, {
    startMarker: '[//]: # "secretref-unsupported-list-start"',
    endMarker: '[//]: # "secretref-unsupported-list-end"',
    body: expectedUnsupportedBlock,
  });
  return next;
}

const checkMode = process.argv.includes("--check");

const currentSurface = fs.readFileSync(surfacePath, "utf8");
const expectedSurface = rebuildSurface(currentSurface);

if (checkMode) {
  const failures: string[] = [];
  const currentMatrixJson = fs.readFileSync(matrixPath, "utf8");
  if (currentMatrixJson !== expectedMatrixJson) {
    failures.push(`docs/reference/secretref-user-supplied-credentials-matrix.json is out of sync.`);
  }
  if (currentSurface !== expectedSurface) {
    failures.push(`docs/reference/secretref-credential-surface.md marker blocks are out of sync.`);
  }
  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(`error: ${failure}`);
    }
    console.error(`Run \`pnpm gen:secretref-docs\` to regenerate.`);
    process.exit(1);
  }
  console.log(`secretref reference docs are in sync.`);
  process.exit(0);
}

fs.writeFileSync(matrixPath, expectedMatrixJson, "utf8");
console.log(`Wrote ${path.relative(repoRoot, matrixPath)}`);

if (currentSurface !== expectedSurface) {
  fs.writeFileSync(surfacePath, expectedSurface, "utf8");
  console.log(`Updated marker blocks in ${path.relative(repoRoot, surfacePath)}`);
} else {
  console.log(`${path.relative(repoRoot, surfacePath)} already in sync`);
}
