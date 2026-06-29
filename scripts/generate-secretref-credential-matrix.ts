// Generate Secretref Credential Matrix script supports OpenClaw repository automation.
import fs from "node:fs";
import path from "node:path";
import { buildSecretRefCredentialMatrix } from "../src/secrets/credential-matrix.js";

const CHECK = process.argv.includes("--check");
const WRITE = process.argv.includes("--write") || !CHECK; // Default to write mode if --check is not specified

const ROOT = path.resolve(import.meta.dirname, "..");

const matrixPath = path.join(ROOT, "docs", "reference", "secretref-user-supplied-credentials-matrix.json");
const surfacePath = path.join(ROOT, "docs", "reference", "secretref-credential-surface.md");

const matrixData = buildSecretRefCredentialMatrix();
const matrixJson = JSON.stringify(matrixData, null, 2) + "\n";

// Load original markdown file
const originalSurface = fs.readFileSync(surfacePath, "utf8");

// Parse current lines to preserve comments/descriptions
const lineMap = new Map<string, string>();
for (const line of originalSurface.split(/\r?\n/)) {
  const match = line.match(/^- `([^`]+)`/);
  if (match) {
    lineMap.set(match[1], line);
  }
}

// Separate keys by config file
const openclawJsonKeys = matrixData.entries
  .filter((entry) => entry.configFile === "openclaw.json")
  .map((entry) => entry.path);

const authProfilesJsonKeys = matrixData.entries
  .filter((entry) => entry.configFile === "auth-profiles.json")
  .map((entry) => entry.refPath ?? entry.path);

// Format openclaw.json targets (sorted, descriptions preserved)
const openclawLines = [...new Set(openclawJsonKeys)].toSorted().map((key) => {
  return lineMap.get(key) ?? `- \`${key}\``;
});

// Format auth-profiles.json targets (sorted, descriptions preserved)
const authProfilesLines = [...new Set(authProfilesJsonKeys)].toSorted().map((key) => {
  return lineMap.get(key) ?? `- \`${key}\``;
});

// Combine with headers and distinct structures
const newSupportedLines = [
  ...openclawLines,
  "",
  "### `auth-profiles.json` targets (`secrets configure` + `secrets apply` + `secrets audit`)",
  "",
  ...authProfilesLines,
];

const unsupportedSet = new Set(matrixData.excludedMutableOrRuntimeManaged);
const newUnsupportedLines = [...unsupportedSet].toSorted().map((key) => {
  return lineMap.get(key) ?? `- \`${key}\``;
});

// Helper to replace block in markdown
function replaceBlock(content: string, startMarker: string, endMarker: string, newLines: string[]): string {
  const startIdx = content.indexOf(startMarker);
  const endIdx = content.indexOf(endMarker);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    throw new Error(`Markers not found: ${startMarker} or ${endMarker}`);
  }
  const before = content.slice(0, startIdx + startMarker.length);
  const after = content.slice(endIdx);
  return `${before}\n\n${newLines.join("\n")}\n\n${after}`;
}

let newSurface = originalSurface;
newSurface = replaceBlock(
  newSurface,
  '[//]: # "secretref-supported-list-start"',
  '[//]: # "secretref-supported-list-end"',
  newSupportedLines
);
newSurface = replaceBlock(
  newSurface,
  '[//]: # "secretref-unsupported-list-start"',
  '[//]: # "secretref-unsupported-list-end"',
  newUnsupportedLines
);

// Normalize line endings to LF
newSurface = newSurface.replace(/\r\n/g, "\n");

if (CHECK) {
  const currentMatrix = fs.readFileSync(matrixPath, "utf8");
  const currentSurface = fs.readFileSync(surfacePath, "utf8").replace(/\r\n/g, "\n");

  let drift = false;
  if (currentMatrix !== matrixJson) {
    console.error("Drift detected in secretref-user-supplied-credentials-matrix.json");
    drift = true;
  }
  if (currentSurface !== newSurface) {
    console.error("Drift detected in secretref-credential-surface.md");
    drift = true;
  }
  if (drift) {
    console.error("Please run: pnpm secretref:docs:gen");
    process.exit(1);
  } else {
    console.log("SecretRef reference docs are up to date.");
  }
} else if (WRITE) {
  fs.writeFileSync(matrixPath, matrixJson, "utf8");
  fs.writeFileSync(surfacePath, newSurface, "utf8");
  console.log("SecretRef reference docs and matrix generated successfully.");
}
