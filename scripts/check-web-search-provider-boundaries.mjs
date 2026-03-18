#!/usr/bin/env node

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runAsScript } from "./lib/ts-guard-utils.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const baselinePath = path.join(
  repoRoot,
  "test",
  "fixtures",
  "web-search-provider-boundary-inventory.json",
);

const scanRoots = ["src", "test", "scripts"];
const scanExtensions = new Set([".ts", ".js", ".mjs", ".cjs"]);
const ignoredDirNames = new Set([
  ".artifacts",
  ".git",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "extensions",
  "node_modules",
]);

const bundledProviderPluginToSearchProvider = new Map([
  ["brave", "brave"],
  ["firecrawl", "firecrawl"],
  ["google", "gemini"],
  ["moonshot", "kimi"],
  ["perplexity", "perplexity"],
  ["xai", "grok"],
]);

const providerIds = new Set([
  "brave",
  "firecrawl",
  "gemini",
  "grok",
  "kimi",
  "perplexity",
  "shared",
]);

const allowedGenericFiles = new Set([
  "src/agents/tools/web-search-core.ts",
  "src/agents/tools/web-search.ts",
  "src/secrets/runtime-web-tools.ts",
  "src/web-search/runtime.ts",
]);

const ignoredFiles = new Set([
  "scripts/check-plugin-extension-import-boundary.mjs",
  "scripts/check-web-search-provider-boundaries.mjs",
  "test/web-search-provider-boundary.test.ts",
]);

function normalizeRelativePath(filePath) {
  return path.relative(repoRoot, filePath).split(path.sep).join("/");
}

async function walkFiles(rootDir) {
  const out = [];
  let entries = [];
  try {
    entries = await fs.readdir(rootDir, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return out;
    }
    throw error;
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const entryPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      if (ignoredDirNames.has(entry.name)) {
        continue;
      }
      out.push(...(await walkFiles(entryPath)));
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    if (!scanExtensions.has(path.extname(entry.name))) {
      continue;
    }
    out.push(entryPath);
  }
  return out;
}

function compareInventoryEntries(left, right) {
  return (
    left.provider.localeCompare(right.provider) ||
    left.file.localeCompare(right.file) ||
    left.line - right.line ||
    left.reason.localeCompare(right.reason)
  );
}

function pushEntry(inventory, entry) {
  if (!providerIds.has(entry.provider)) {
    throw new Error(`Unknown provider id in boundary inventory: ${entry.provider}`);
  }
  inventory.push(entry);
}

function scanWebSearchProviderRegistry(lines, relativeFile, inventory) {
  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1;

    if (line.includes("firecrawl-search-provider.js")) {
      pushEntry(inventory, {
        provider: "shared",
        file: relativeFile,
        line: lineNumber,
        reason: "imports extension web search provider implementation into core registry",
      });
    }

    if (line.includes("web-search-plugin-factory.js")) {
      pushEntry(inventory, {
        provider: "shared",
        file: relativeFile,
        line: lineNumber,
        reason: "imports shared web search provider registration helper into core registry",
      });
    }

    const pluginMatch = line.match(/pluginId:\s*"([^"]+)"/);
    const providerFromPlugin = pluginMatch
      ? bundledProviderPluginToSearchProvider.get(pluginMatch[1])
      : undefined;
    if (providerFromPlugin) {
      pushEntry(inventory, {
        provider: providerFromPlugin,
        file: relativeFile,
        line: lineNumber,
        reason: "hardcodes bundled web search plugin ownership in core registry",
      });
    }

    const providerMatch = line.match(/id:\s*"(brave|firecrawl|gemini|grok|kimi|perplexity)"/);
    if (providerMatch) {
      pushEntry(inventory, {
        provider: providerMatch[1],
        file: relativeFile,
        line: lineNumber,
        reason: "hardcodes bundled web search provider id in core registry",
      });
    }
  }
}

function scanOnboardSearch(lines, relativeFile, inventory) {
  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1;

    if (line.includes("web-search-providers.js")) {
      pushEntry(inventory, {
        provider: "shared",
        file: relativeFile,
        line: lineNumber,
        reason: "imports bundled web search registry into core onboarding flow",
      });
    }

    if (line.includes("const SEARCH_PROVIDER_IDS = [")) {
      for (const provider of ["brave", "firecrawl", "gemini", "grok", "kimi", "perplexity"]) {
        if (!line.includes(`"${provider}"`)) {
          continue;
        }
        pushEntry(inventory, {
          provider,
          file: relativeFile,
          line: lineNumber,
          reason: "hardcodes bundled web search provider inventory in core onboarding flow",
        });
      }
    }

    if (
      line.includes('provider !== "firecrawl"') ||
      line.includes('enablePluginInConfig(next, "firecrawl")')
    ) {
      pushEntry(inventory, {
        provider: "firecrawl",
        file: relativeFile,
        line: lineNumber,
        reason: "hardcodes provider-specific plugin enablement coupling in core onboarding flow",
      });
    }
  }
}

function scanGenericCoreImports(lines, relativeFile, inventory) {
  if (allowedGenericFiles.has(relativeFile)) {
    return;
  }
  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1;
    if (line.includes("web-search-providers.js")) {
      pushEntry(inventory, {
        provider: "shared",
        file: relativeFile,
        line: lineNumber,
        reason: "imports bundled web search registry outside allowed generic plumbing",
      });
    }
    if (line.includes("web-search-plugin-factory.js")) {
      pushEntry(inventory, {
        provider: "shared",
        file: relativeFile,
        line: lineNumber,
        reason: "imports web search provider registration helper outside extensions",
      });
    }
  }
}

export async function collectWebSearchProviderBoundaryInventory() {
  const inventory = [];
  const files = (
    await Promise.all(scanRoots.map(async (root) => await walkFiles(path.join(repoRoot, root))))
  )
    .flat()
    .toSorted((left, right) =>
      normalizeRelativePath(left).localeCompare(normalizeRelativePath(right)),
    );

  for (const filePath of files) {
    const relativeFile = normalizeRelativePath(filePath);
    if (ignoredFiles.has(relativeFile)) {
      continue;
    }
    const content = await fs.readFile(filePath, "utf8");
    const lines = content.split(/\r?\n/);

    if (relativeFile === "src/plugins/web-search-providers.ts") {
      scanWebSearchProviderRegistry(lines, relativeFile, inventory);
      continue;
    }

    if (relativeFile === "src/commands/onboard-search.ts") {
      scanOnboardSearch(lines, relativeFile, inventory);
      continue;
    }

    scanGenericCoreImports(lines, relativeFile, inventory);
  }

  return inventory.toSorted(compareInventoryEntries);
}

export async function readExpectedInventory() {
  return JSON.parse(await fs.readFile(baselinePath, "utf8"));
}

export function diffInventory(expected, actual) {
  const expectedKeys = new Set(expected.map((entry) => JSON.stringify(entry)));
  const actualKeys = new Set(actual.map((entry) => JSON.stringify(entry)));
  const missing = expected.filter((entry) => !actualKeys.has(JSON.stringify(entry)));
  const unexpected = actual.filter((entry) => !expectedKeys.has(JSON.stringify(entry)));
  return {
    missing: missing.toSorted(compareInventoryEntries),
    unexpected: unexpected.toSorted(compareInventoryEntries),
  };
}

function formatInventoryHuman(inventory) {
  if (inventory.length === 0) {
    return "No web search provider boundary inventory entries found.";
  }
  const lines = ["Web search provider boundary inventory:"];
  let activeProvider = "";
  for (const entry of inventory) {
    if (entry.provider !== activeProvider) {
      activeProvider = entry.provider;
      lines.push(`${activeProvider}:`);
    }
    lines.push(`  - ${entry.file}:${entry.line} ${entry.reason}`);
  }
  return lines.join("\n");
}

function formatEntry(entry) {
  return `${entry.provider} ${entry.file}:${entry.line} ${entry.reason}`;
}

export async function main(argv = process.argv.slice(2)) {
  const json = argv.includes("--json");
  const actual = await collectWebSearchProviderBoundaryInventory();
  const expected = await readExpectedInventory();
  const { missing, unexpected } = diffInventory(expected, actual);
  const matchesBaseline = missing.length === 0 && unexpected.length === 0;

  if (json) {
    process.stdout.write(`${JSON.stringify(actual, null, 2)}\n`);
  } else {
    console.log(formatInventoryHuman(actual));
    console.log(
      matchesBaseline
        ? `Baseline matches (${actual.length} entries).`
        : `Baseline mismatch (${unexpected.length} unexpected, ${missing.length} missing).`,
    );
    if (!matchesBaseline) {
      if (unexpected.length > 0) {
        console.error("Unexpected entries:");
        for (const entry of unexpected) {
          console.error(`- ${formatEntry(entry)}`);
        }
      }
      if (missing.length > 0) {
        console.error("Missing baseline entries:");
        for (const entry of missing) {
          console.error(`- ${formatEntry(entry)}`);
        }
      }
    }
  }

  if (!matchesBaseline) {
    process.exit(1);
  }
}

runAsScript(import.meta.url, main);
