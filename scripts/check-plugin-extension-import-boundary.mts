#!/usr/bin/env node

// Inventories core plugin imports that cross into bundled extension files.
import { existsSync } from "node:fs";
import path from "node:path";
import {
  compareEntries,
  createExtensionImportBoundaryChecker,
} from "./lib/extension-import-boundary-checker.mts";
import {
  formatGroupedInventoryHuman,
  resolveRepoSpecifier,
  writeLine,
} from "./lib/guard-inventory-utils.mjs";
import { resolveRepoRoot } from "./lib/repo-root.mjs";
import { runAsScript } from "./lib/ts-guard-utils.mts";

const repoRoot = resolveRepoRoot(import.meta.url);
const AUTHORED_MODULE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const RETIRED_WEB_SEARCH_CORE_MODULES = [
  "src/agents/tools/web-search-plugin-factory",
  "src/plugins/bundled-web-search-registry",
  "src/plugins/web-search-providers",
] as const;
// Skill Workshop moved into extensions/skill-workshop; these core paths stay retired.
const RETIRED_SKILL_WORKSHOP_CORE_DIR = "src/skills/workshop";
const RETIRED_SKILL_WORKSHOP_CORE_MODULES = [
  "src/agents/skill-workshop-prompt",
  "src/agents/tools/skill-workshop-tool",
  "src/agents/tools/skill-workshop-tool-factory",
  "src/agents/tools/skill-workshop-tool-schema",
  "src/gateway/server-methods/skills-workshop",
  "src/flows/doctor-skill-workshop-check",
] as const;
const SKILL_WORKSHOP_PLUGIN_PREFIX = "extensions/skill-workshop/";
// Core and core tests reach the plugin only through its public barrel.
const SKILL_WORKSHOP_PUBLIC_BARRELS = new Set([
  "extensions/skill-workshop/api.ts",
  "extensions/skill-workshop/api.js",
]);

type PluginExtensionInventoryEntry = {
  file: string;
  line: number;
  kind: string;
  specifier: string;
  resolvedPath: string | null;
  reason: string;
};
function classifyResolvedExtensionReason(kind: string, resolvedPath: string | null) {
  const verb =
    kind === "export"
      ? "re-exports"
      : kind === "dynamic-import"
        ? "dynamically imports"
        : "imports";
  if (/^extensions\/[^/]+\/src\//.test(resolvedPath ?? "")) {
    return `${verb} extension implementation from src/plugins`;
  }
  if (/^extensions\/[^/]+\/index\.[^/]+$/.test(resolvedPath ?? "")) {
    return `${verb} extension entrypoint from src/plugins`;
  }
  return `${verb} extension-owned file from src/plugins`;
}

const boundaryChecker = createExtensionImportBoundaryChecker({
  roots: ["src/plugins"],
  shouldSkipFile(relativeFile) {
    return (
      relativeFile.startsWith("src/plugins/contracts/") ||
      /^src\/plugins\/runtime\/runtime-[^/]+-contract\.[cm]?[jt]s$/u.test(relativeFile)
    );
  },
  collectEntries({ filePath, relativeFile, references }) {
    return references.map(({ kind, line, specifier }) => {
      const resolvedPath = resolveRepoSpecifier(repoRoot, specifier, filePath);
      return {
        file: relativeFile,
        line,
        kind,
        specifier,
        resolvedPath,
        reason: classifyResolvedExtensionReason(kind, resolvedPath),
      };
    });
  },
  compareEntries,
});

/** Rejects retired core registries whose ownership now comes from plugin manifests. */
export function collectRetiredWebSearchCorePathEntries(
  rootDir = repoRoot,
): PluginExtensionInventoryEntry[] {
  return RETIRED_WEB_SEARCH_CORE_MODULES.flatMap((modulePath) =>
    AUTHORED_MODULE_EXTENSIONS.map((extension) => `${modulePath}${extension}`),
  )
    .filter((relativeFile) => existsSync(path.join(rootDir, relativeFile)))
    .map((relativeFile) => ({
      file: relativeFile,
      line: 1,
      kind: "retired-path",
      specifier: relativeFile,
      resolvedPath: relativeFile,
      reason: "restores retired core web-search registry or factory ownership",
    }));
}

/** Rejects core modules Skill Workshop retired when it moved into its bundled plugin. */
export function collectRetiredSkillWorkshopCorePathEntries(
  rootDir = repoRoot,
): PluginExtensionInventoryEntry[] {
  return [
    // Any file there restores the retired directory; one entry names it.
    ...(existsSync(path.join(rootDir, RETIRED_SKILL_WORKSHOP_CORE_DIR))
      ? [RETIRED_SKILL_WORKSHOP_CORE_DIR]
      : []),
    ...RETIRED_SKILL_WORKSHOP_CORE_MODULES.flatMap((modulePath) =>
      AUTHORED_MODULE_EXTENSIONS.map((extension) => `${modulePath}${extension}`),
    ).filter((relativeFile) => existsSync(path.join(rootDir, relativeFile))),
  ].map((relativeFile) => ({
    file: relativeFile,
    line: 1,
    kind: "retired-path",
    specifier: relativeFile,
    resolvedPath: relativeFile,
    reason: "restores retired core Skill Workshop code; it belongs to extensions/skill-workshop",
  }));
}

// Core, UI and packages may import Skill Workshop only through its public barrel.
const skillWorkshopBoundaryChecker = createExtensionImportBoundaryChecker({
  roots: ["src", "ui/src", "packages"],
  skipSourcesWithoutBundledPluginPrefix: true,
  acceptSpecifier: (_specifier, { resolvedPath }) =>
    Boolean(resolvedPath?.startsWith(SKILL_WORKSHOP_PLUGIN_PREFIX)),
  collectEntries({ filePath, relativeFile, references }) {
    return references.flatMap(({ kind, line, specifier }) => {
      const resolvedPath = resolveRepoSpecifier(repoRoot, specifier, filePath);
      return resolvedPath && SKILL_WORKSHOP_PUBLIC_BARRELS.has(resolvedPath)
        ? []
        : [
            {
              file: relativeFile,
              line,
              kind,
              specifier,
              resolvedPath,
              reason: "reaches Skill Workshop internals; use extensions/skill-workshop/api.ts",
            },
          ];
    });
  },
  compareEntries,
});

/** Inventory of src/plugins extension imports, core Skill Workshop imports and retired paths. */
async function collectPluginExtensionImportBoundaryInventory() {
  return [
    ...(await boundaryChecker.collectInventory()),
    ...(await skillWorkshopBoundaryChecker.collectInventory()),
    ...collectRetiredWebSearchCorePathEntries(),
    ...collectRetiredSkillWorkshopCorePathEntries(),
  ].toSorted(compareEntries);
}

const ruleText =
  "Rule: src/plugins/** must not import bundled plugin files, core must reach Skill Workshop only through its api.ts, and retired web-search registries and core Skill Workshop paths stay deleted";
const formatInventoryHuman = (inventory: PluginExtensionInventoryEntry[]) =>
  formatGroupedInventoryHuman(
    {
      rule: ruleText,
      cleanMessage: "No plugin import boundary violations found.",
      inventoryTitle: "Plugin extension import boundary inventory:",
    },
    inventory,
  );

async function runPluginExtensionImportBoundaryCheck(): Promise<0 | 1> {
  const actual = await collectPluginExtensionImportBoundaryInventory();

  writeLine(process.stdout, formatInventoryHuman(actual));
  if (actual.length === 0) {
    return 0;
  }
  writeLine(process.stderr, `${ruleText} violations found (${actual.length}).`);
  return 1;
}

runAsScript(import.meta.url, async () => {
  process.exitCode = await runPluginExtensionImportBoundaryCheck();
});
