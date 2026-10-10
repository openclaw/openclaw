#!/usr/bin/env node

// Reports plugin SDK export surface metadata.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import * as ts from "typescript/unstable/ast";
import {
  SignatureKind,
  SymbolFlags,
  type Checker,
  type Project,
  type Symbol,
} from "typescript/unstable/async";
import { listPluginCompatRecords } from "../src/plugins/compat/registry.js";
import { booleanFlag, parseFlagArgs } from "./lib/arg-utils.mts";
import { formatNativeTypeScriptDiagnostics } from "./lib/native-typescript-diagnostics.mts";
import { createNativeTypeScriptProjectAsync } from "./lib/native-typescript.mts";
import {
  deprecatedBarrelPluginSdkEntrypoints,
  deprecatedPublicPluginSdkEntrypoints,
  packagedPrivatePluginSdkRuntimeEntrypoints,
  pluginSdkEntrypoints,
  privateLocalOnlyPluginSdkEntrypoints,
  publicPluginSdkEntrypoints,
} from "./lib/plugin-sdk-entries.mts";
import {
  compareStableReleases,
  evaluatePluginSdkShippedSurface,
  formatPluginSdkShippedSurfaceFailures,
  isStableRelease,
  parsePluginSdkShippedSurface,
  shippedSurfacePath,
  typedPluginSdkSubpaths,
} from "./lib/plugin-sdk-shipped-surface.mts";
import { resolveRepoRoot } from "./lib/repo-root.mjs";

const repoRoot = resolveRepoRoot(import.meta.url);

type ExportEntryStats = {
  callableExports: number;
  deprecatedCallableExports: number;
  deprecatedExports: number;
  exports: number;
  exportNames: string[];
};

function usage() {
  return `Usage: node --import tsx scripts/plugin-sdk-surface-report.mts [--check]

Reports plugin SDK export surface metadata.

Options:
  --check     Fail on unauthorized shipped-surface removals or exceeded SDK budgets.
  -h, --help  Show this help.
`;
}

function parsePluginSdkSurfaceReportArgs(argv: string[]) {
  return parseFlagArgs(
    argv,
    { check: false, help: false },
    [
      booleanFlag("--check", "check", true, { repeatable: true }),
      booleanFlag("--help", "help", true, { repeatable: true }),
      booleanFlag("-h", "help", true, { repeatable: true }),
    ],
    {
      ignoreDoubleDash: false,
      onUnhandledArg(arg: string) {
        throw new Error(`Unknown plugin SDK surface report option: ${arg}`);
      },
    },
  );
}
const publicEntrypointSet = new Set(publicPluginSdkEntrypoints);
const localOnlyEntrypointSet = new Set(privateLocalOnlyPluginSdkEntrypoints);
const packagedPrivateRuntimeEntrypointSet = new Set(packagedPrivatePluginSdkRuntimeEntrypoints);
const deprecatedPublicEntrypointSet = new Set(deprecatedPublicPluginSdkEntrypoints);
const deprecatedBarrelEntrypointSet = new Set(deprecatedBarrelPluginSdkEntrypoints);
const forbiddenPublicSubpaths = new Set(["test-utils"]);

function readPluginSdkSurfaceBudgetEnv(
  name: string,
  fallback: number,
  env: NodeJS.ProcessEnv = process.env,
) {
  const raw = env[name];
  if (raw === undefined) {
    return fallback;
  }
  const value = raw.trim();
  if (!/^\d+$/u.test(value)) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${name} must be a safe non-negative integer`);
  }
  return parsed;
}

function readPluginSdkEntrypointBudgetEnv(
  name: string,
  fallback: Readonly<Record<string, number>>,
  env: NodeJS.ProcessEnv = process.env,
) {
  const raw = env[name];
  if (raw === undefined) {
    return fallback;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${name} must be a JSON object of entrypoint integer budgets`);
  }
  if (!isRecord(parsed)) {
    throw new Error(`${name} must be a JSON object of entrypoint integer budgets`);
  }

  const overrides: Record<string, number> = {};
  for (const [entrypoint, value] of Object.entries(parsed)) {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
      throw new Error(`${name}.${entrypoint} must be a safe non-negative integer`);
    }
    overrides[entrypoint] = value;
  }
  return Object.freeze({ ...fallback, ...overrides });
}

const defaultPublicDeprecatedExportsByEntrypointBudget = Object.freeze({
  // +1 each: legacy AgentHarness remains projected through the core and plugin-entry
  // compatibility barrels while external harnesses migrate to AgentHarnessV2.
  // +2 each: released provider replay contracts remain while plugins adopt async V2.
  core: 5,
  "plugin-entry": 3,
  // Shipped synchronous capture remains available while plugins migrate to async capture.
  "proxy-capture": 9,
  routing: 1,
  // +4: shipped default/session-agent resolvers remain available through
  // compatibility barrels while callers migrate to explicit/sole selection.
  health: 1,
  "agent-scope-runtime": 4,
  // +1: shipped channel setup state-migration declaration during its migration window.
  "channel-entry-contract": 1,
  "approval-gateway-runtime": 1,
  "approval-handler-runtime": 1,
  "approval-reply-runtime": 0,
  "config-contracts": 0,
  "inbound-reply-dispatch": 21,
  "interactive-runtime": 11,
  "ssrf-policy": 1,
  "ssrf-runtime": 1,
  // +1: deprecated agent media projection re-export during the media migration window.
  "media-runtime": 3,
  // +3: deprecated media projection type, builder, and local-roots compatibility re-export.
  "agent-media-payload": 3,
  // +2: deprecated media projection type and builder.
  "reply-payload": 2,
  "agent-runtime": 4,
  "memory-host-core": 2,
  // +4: session-write lease no-op compatibility stubs through the 2026.10 train.
  // +4: legacy AgentHarness, attempt, embedded-run, and side-question contracts remain
  // deprecated while external harnesses migrate to required-capability V2 contracts.
  // +1: bounded structured-input compiler/executor for native harness protocol adapters.
  // +1: owner-approved async tool construction retains the deprecated synchronous factory.
  "agent-harness": 3,
  // +1: owner-approved synchronous watched-session compatibility during async migration.
  // +1: owner-approved synchronous agent-end compatibility during async migration.
  "agent-harness-runtime": 12,
  // +4: deprecated media projection type, builder, and turn aliases.
  "channel-inbound": 21,
  "inbound-envelope": 3,
  // +2: Slack progress-draft render bridge (function + mode type).
  "channel-outbound": 2,
  // +2: WhatsApp ack-policy bridge (function + mode type).
  "channel-feedback": 2,
  // Released synchronous allowlist compatibility during the approved worker-read migration.
  "channel-pairing": 1,
  "channel-policy": 7,
  "channel-send-result": 1,
  "reply-runtime": 1,
  "security-runtime": 1,
  // +2: approved released upstream-link writes retained during worker migration.
  "session-catalog": 2,
  "session-store-runtime": 4,
  // +2: shipped Slack and Discord setup helpers retained through their package migration window.
  "setup-runtime": 2,
  "reply-history": 6,
  "provider-auth": 15,
} satisfies Record<string, number>);

export function readPluginSdkSurfaceBudgets(env: NodeJS.ProcessEnv = process.env) {
  const budgets = {
    publicEntrypoints: readPluginSdkSurfaceBudgetEnv(
      "OPENCLAW_PLUGIN_SDK_MAX_PUBLIC_ENTRYPOINTS",
      // +1: the shared state-owner boundary for plugin CLIs.
      152,
      env,
    ),
    publicExports: readPluginSdkSurfaceBudgetEnv(
      "OPENCLAW_PLUGIN_SDK_MAX_PUBLIC_EXPORTS",
      // +1: createChannelSecretContract consolidates seven channel secret contracts (approved by Peter, 2026-10-01).
      // +4: owner-approved replay V2 types on core and plugin-entry (2026-10-01).
      // +11: ten service-lifetime type exports and the owner-bound scheduler resolver.
      // +1: owner-approved async watched-session preparation with retained sync compatibility.
      // +1: captureToolAuthoredSourceReply lets the Codex harness deliver canDeliverSourceReply tool replies.
      // +1: owner-approved async agent-end preparation with retained sync compatibility.
      // +1: owner-approved async coding-tool construction with retained sync compatibility.
      // +4: executor controller, binding, context, and resolver.
      // +1: required session cleanup failure preserves native ownership before host reset.
      // +2: approved async upstream-link writes with released sync compatibility.
      // -8: retired Skill Workshop proposal hook types.
      // +3: approved async session entry reads and typed incognito refusal on the existing subpath.
      // +7: approved prepared/data-only session patches and their authority contracts.
      // +4: CLI state-owner routing, Gateway owner guards, target selection, and timeout parsing.
      3655,
      env,
    ),
    publicFunctionExports: readPluginSdkSurfaceBudgetEnv(
      "OPENCLAW_PLUGIN_SDK_MAX_PUBLIC_FUNCTION_EXPORTS",
      // +1: createChannelSecretContract consolidates seven channel secret contracts (approved by Peter, 2026-10-01).
      // +1: resolvePluginServiceScheduler borrows an existing service/account/CLI owner.
      // +1: owner-approved async watched-session preparation with retained sync compatibility.
      // +1: captureToolAuthoredSourceReply lets the Codex harness deliver canDeliverSourceReply tool replies.
      // +1: owner-approved async agent-end preparation with retained sync compatibility.
      // +1: owner-approved async coding-tool construction with retained sync compatibility.
      // +1: resolve the controller from the current invocation registry.
      // +2: approved async upstream-link writes with released sync compatibility.
      // +3: approved async session entry reads and typed incognito refusal on the existing subpath.
      // +3: approved prepared/data-only session patches and authority-bound routes.
      // +4: the same four CLI state-owner and transport functions.
      2121,
      env,
    ),
    publicDeprecatedExports: readPluginSdkSurfaceBudgetEnv(
      "OPENCLAW_PLUGIN_SDK_MAX_PUBLIC_DEPRECATED_EXPORTS",
      // Remove deprecated sync channel envelope helpers and their compat records at the next Plugin SDK major.
      // +2: approved synchronous upstream-link write compatibility until the next Plugin SDK major.
      // +1: synchronous session entry getter remains until the next Plugin SDK major.
      // +6: released session callbacks and provider replay contracts during async migration.
      154,
      env,
    ),
    publicWildcardReexports: readPluginSdkSurfaceBudgetEnv(
      "OPENCLAW_PLUGIN_SDK_MAX_PUBLIC_WILDCARD_REEXPORTS",
      0,
      env,
    ),
  };
  const publicDeprecatedExportsByEntrypointBudget = readPluginSdkEntrypointBudgetEnv(
    "OPENCLAW_PLUGIN_SDK_MAX_PUBLIC_DEPRECATED_EXPORTS_BY_ENTRYPOINT",
    defaultPublicDeprecatedExportsByEntrypointBudget,
    env,
  );
  return { budgets, publicDeprecatedExportsByEntrypointBudget };
}

function entrypointPath(entrypoint: string) {
  return path.join(repoRoot, "src", "plugin-sdk", `${entrypoint}.ts`);
}

function readPackageExportedSubpaths() {
  const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  return Object.keys(packageJson.exports ?? {})
    .filter((key) => key.startsWith("./plugin-sdk/"))
    .map((key) => key.slice("./plugin-sdk/".length))
    .toSorted();
}

function unwrapAlias(checker: Checker, symbol: Symbol) {
  return symbol.flags & SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
}

async function hasDeprecatedTag(checker: Checker, symbol: Symbol) {
  return (await checker.getJsDocTagsOfSymbol(symbol)).some((tag) => tag.name === "deprecated");
}

async function isCallableExport(checker: Checker, target: Symbol, sourceFile: ts.SourceFile) {
  const declaration =
    (await target.valueDeclaration?.resolve()) ??
    (await target.declarations[0]?.resolve()) ??
    sourceFile;
  const type = await checker.getTypeOfSymbolAtLocation(target, declaration);
  return (await checker.getSignaturesOfType(type, SignatureKind.Call)).length > 0;
}

function countWildcardReexports(entrypoints: string[]) {
  let count = 0;
  const matches: string[] = [];
  for (const entrypoint of entrypoints) {
    const sourcePath = entrypointPath(entrypoint);
    const source = fs.readFileSync(sourcePath, "utf8");
    const lines = source.split(/\r?\n/u);
    for (const [index, line] of lines.entries()) {
      if (/^\s*export\s+(?:type\s+)?\*\s+from\s+["'][^"']+["']/u.test(line)) {
        count += 1;
        matches.push(`${path.relative(repoRoot, sourcePath)}:${index + 1}`);
      }
    }
  }
  return { count, matches };
}

async function collectExportStats(project: Project, entrypoints: string[]) {
  const { program, checker } = project;
  const byEntrypoint = new Map<string, ExportEntryStats>();

  for (const entrypoint of entrypoints) {
    const sourceFile = await program.getSourceFile(entrypointPath(entrypoint));
    if (!sourceFile) {
      byEntrypoint.set(entrypoint, {
        exports: 0,
        exportNames: [],
        callableExports: 0,
        deprecatedExports: 0,
        deprecatedCallableExports: 0,
      });
      continue;
    }
    const moduleSymbol = await checker.getSymbolAtLocation(sourceFile);
    const symbols = moduleSymbol ? await checker.getExportsOfModule(moduleSymbol) : [];
    let callableExports = 0;
    let deprecatedExports = 0;
    let deprecatedCallableExports = 0;
    const deprecatedEntrypoint = deprecatedPublicEntrypointSet.has(entrypoint);
    // Let the native client batch one entrypoint's reads, and settle them all before closing it.
    const observations = await Promise.allSettled(
      symbols.map(async (symbol) => {
        const target = await unwrapAlias(checker, symbol);
        const callable = await isCallableExport(checker, target, sourceFile);
        const deprecated =
          deprecatedEntrypoint ||
          (await hasDeprecatedTag(checker, symbol)) ||
          (await hasDeprecatedTag(checker, target));
        return { callable, deprecated };
      }),
    );
    for (const observation of observations) {
      if (observation.status === "rejected") {
        throw observation.reason;
      }
      const { callable, deprecated } = observation.value;
      if (callable) {
        callableExports += 1;
      }
      if (deprecated) {
        deprecatedExports += 1;
        if (callable) {
          deprecatedCallableExports += 1;
        }
      }
    }
    byEntrypoint.set(entrypoint, {
      exports: symbols.length,
      exportNames: symbols
        .map((symbol) => symbol.name)
        .filter((name) => name !== "default")
        .toSorted(),
      callableExports,
      deprecatedExports,
      deprecatedCallableExports,
    });
  }

  return byEntrypoint;
}

function selectExportStats(
  scannedStats: Awaited<ReturnType<typeof collectExportStats>>,
  entrypoints: string[],
) {
  const byEntrypoint = new Map<string, ExportEntryStats>();
  const totals = {
    entrypoints: entrypoints.length,
    exports: 0,
    callableExports: 0,
    deprecatedExports: 0,
    deprecatedCallableExports: 0,
    uniqueExports: 0,
    uniqueCallableExports: 0,
  };
  for (const entrypoint of entrypoints) {
    const stats = scannedStats.get(entrypoint) ?? {
      exportNames: [],
      exports: 0,
      callableExports: 0,
      deprecatedExports: 0,
      deprecatedCallableExports: 0,
    };
    byEntrypoint.set(entrypoint, stats);
    totals.exports += stats.exports;
    totals.callableExports += stats.callableExports;
    totals.deprecatedExports += stats.deprecatedExports;
    totals.deprecatedCallableExports += stats.deprecatedCallableExports;
  }
  // Export identities are entrypoint-qualified, so the selected totals are unique.
  totals.uniqueExports = totals.exports;
  totals.uniqueCallableExports = totals.callableExports;
  return { byEntrypoint, totals };
}

function formatStats(label: string, stats: ReturnType<typeof selectExportStats>["totals"]) {
  return [
    `${label}:`,
    `  entrypoints: ${stats.entrypoints}`,
    `  exports: ${stats.exports}`,
    `  callable exports: ${stats.callableExports}`,
    `  deprecated exports: ${stats.deprecatedExports}`,
    `  deprecated callable exports: ${stats.deprecatedCallableExports}`,
    `  unique entrypoint-qualified exports: ${stats.uniqueExports}`,
  ].join("\n");
}

function collectDeprecatedEntrypointBudgetFailures(
  byEntrypoint: Awaited<ReturnType<typeof collectExportStats>>,
  entrypointBudgets: Readonly<Record<string, number>>,
) {
  const failures: string[] = [];
  for (const [entrypoint, stats] of byEntrypoint) {
    const budget = entrypointBudgets[entrypoint] ?? 0;
    if (stats.deprecatedExports > budget) {
      failures.push(
        `public deprecated exports in ${entrypoint} ${stats.deprecatedExports} > ${budget}`,
      );
    }
  }
  return failures;
}

export async function collectPluginSdkSurfaceReport() {
  const typedSubpaths = typedPluginSdkSubpaths(
    JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")),
  );
  const scannedEntrypoints = [
    ...new Set([
      ...pluginSdkEntrypoints,
      ...publicPluginSdkEntrypoints,
      ...typedSubpaths,
      ...privateLocalOnlyPluginSdkEntrypoints,
    ]),
  ];
  // All inventories share one native graph; its handles never escape this report.
  const configFileName = path.join(repoRoot, "tsconfig.plugin-sdk-surface-report.json");
  const session = await createNativeTypeScriptProjectAsync({
    cwd: repoRoot,
    configFileName,
    files: {
      [configFileName]: JSON.stringify({
        extends: "./tsconfig.json",
        compilerOptions: {
          allowJs: false,
          declaration: true,
          emitDeclarationOnly: true,
          module: "ESNext",
          moduleResolution: "Bundler",
          noEmit: true,
          skipLibCheck: true,
          strict: false,
          target: "ES2022",
          types: [],
        },
        files: scannedEntrypoints.map(entrypointPath),
        include: [],
      }),
    },
  });
  try {
    const diagnostics = await session.project.program.getConfigFileParsingDiagnostics();
    if (diagnostics.length) {
      throw new Error(formatNativeTypeScriptDiagnostics(diagnostics));
    }
    const scannedStats = await collectExportStats(session.project, scannedEntrypoints);
    const allStats = selectExportStats(scannedStats, pluginSdkEntrypoints);
    const publicStats = selectExportStats(scannedStats, publicPluginSdkEntrypoints);
    const localOnlyStats = selectExportStats(scannedStats, privateLocalOnlyPluginSdkEntrypoints);
    const publicWildcards = countWildcardReexports(publicPluginSdkEntrypoints);
    const leakedForbiddenExports = readPackageExportedSubpaths().filter((subpath) =>
      forbiddenPublicSubpaths.has(subpath),
    );
    const localOnlyStillPublic = privateLocalOnlyPluginSdkEntrypoints.filter(
      (entrypoint) =>
        publicEntrypointSet.has(entrypoint) && !packagedPrivateRuntimeEntrypointSet.has(entrypoint),
    );
    const localOnlyMissingFromInventory = [...localOnlyEntrypointSet].filter(
      (entrypoint) => !pluginSdkEntrypoints.includes(entrypoint),
    );
    const deprecatedMissingFromPublic = [...deprecatedPublicEntrypointSet].filter(
      (entrypoint) => !publicEntrypointSet.has(entrypoint),
    );
    const deprecatedBarrelMissingFromInventory = [...deprecatedBarrelEntrypointSet].filter(
      (entrypoint) => !pluginSdkEntrypoints.includes(entrypoint),
    );
    const deprecatedBarrelWithoutReexports: string[] = [];
    for (const entrypoint of deprecatedBarrelEntrypointSet) {
      const source = await session.project.program.getSourceFile(entrypointPath(entrypoint));
      // Frozen facades retain named reexports without inheriting new APIs through a wildcard.
      if (
        !source?.statements.some(
          (statement) =>
            ts.isExportDeclaration(statement) &&
            statement.moduleSpecifier !== undefined &&
            (!statement.exportClause ||
              ts.isNamespaceExport(statement.exportClause) ||
              statement.exportClause.elements.length > 0),
        )
      ) {
        deprecatedBarrelWithoutReexports.push(entrypoint);
      }
    }
    return {
      typedPublicSurface: new Map(
        typedSubpaths.map((subpath) => [subpath, scannedStats.get(subpath)?.exportNames ?? []]),
      ),
      typedPublicMismatches: [
        ...typedSubpaths.filter((subpath) => !publicEntrypointSet.has(subpath)),
        ...publicPluginSdkEntrypoints.filter((subpath) => !typedSubpaths.includes(subpath)),
      ],
      allStats,
      deprecatedBarrelMissingFromInventory,
      deprecatedBarrelWithoutReexports,
      deprecatedMissingFromPublic,
      leakedForbiddenExports,
      localOnlyMissingFromInventory,
      localOnlyStats,
      localOnlyStillPublic,
      publicStats,
      publicWildcards,
    };
  } finally {
    await session.close();
  }
}

export function evaluatePluginSdkSurfaceReport(
  report: Awaited<ReturnType<typeof collectPluginSdkSurfaceReport>>,
  {
    budgets,
    publicDeprecatedExportsByEntrypointBudget,
  }: ReturnType<typeof readPluginSdkSurfaceBudgets>,
) {
  const failures: string[] = [];
  if (report.typedPublicMismatches.length) {
    failures.push(
      `typed package exports disagree with publicPluginSdkEntrypoints: ${report.typedPublicMismatches.join(", ")}`,
    );
  }
  if (publicPluginSdkEntrypoints.length > budgets.publicEntrypoints) {
    failures.push(
      `public entrypoints ${publicPluginSdkEntrypoints.length} > ${budgets.publicEntrypoints}`,
    );
  }
  if (report.publicStats.totals.exports > budgets.publicExports) {
    failures.push(`public exports ${report.publicStats.totals.exports} > ${budgets.publicExports}`);
  }
  if (report.publicStats.totals.callableExports > budgets.publicFunctionExports) {
    failures.push(
      `public callable exports ${report.publicStats.totals.callableExports} > ${budgets.publicFunctionExports}`,
    );
  }
  if (report.publicStats.totals.deprecatedExports > budgets.publicDeprecatedExports) {
    failures.push(
      `public deprecated exports ${report.publicStats.totals.deprecatedExports} > ${budgets.publicDeprecatedExports}`,
    );
  }
  failures.push(
    ...collectDeprecatedEntrypointBudgetFailures(
      report.publicStats.byEntrypoint,
      publicDeprecatedExportsByEntrypointBudget,
    ),
  );
  if (report.publicWildcards.count > budgets.publicWildcardReexports) {
    failures.push(
      `public wildcard reexports ${report.publicWildcards.count} > ${budgets.publicWildcardReexports}`,
    );
  }
  if (report.leakedForbiddenExports.length > 0) {
    failures.push(`forbidden public subpaths: ${report.leakedForbiddenExports.join(", ")}`);
  }
  if (report.localOnlyStillPublic.length > 0) {
    failures.push(`local-only entrypoints still public: ${report.localOnlyStillPublic.join(", ")}`);
  }
  if (report.localOnlyMissingFromInventory.length > 0) {
    failures.push(
      `local-only entrypoints missing from inventory: ${report.localOnlyMissingFromInventory.join(", ")}`,
    );
  }
  if (report.deprecatedMissingFromPublic.length > 0) {
    failures.push(
      `deprecated public entrypoints missing from package surface: ${report.deprecatedMissingFromPublic.join(", ")}`,
    );
  }
  if (report.deprecatedBarrelMissingFromInventory.length > 0) {
    failures.push(
      `deprecated barrel entrypoints missing from inventory: ${report.deprecatedBarrelMissingFromInventory.join(", ")}`,
    );
  }
  if (report.deprecatedBarrelWithoutReexports.length > 0) {
    failures.push(
      `deprecated barrel entrypoints without reexports: ${report.deprecatedBarrelWithoutReexports.join(", ")}`,
    );
  }
  return failures;
}

function renderPluginSdkSurfaceReport(
  report: Awaited<ReturnType<typeof collectPluginSdkSurfaceReport>>,
) {
  return [
    formatStats("all SDK entrypoints", report.allStats.totals),
    formatStats("public package SDK entrypoints", report.publicStats.totals),
    formatStats("local-only SDK entrypoints", report.localOnlyStats.totals),
    `deprecated public subpaths: ${deprecatedPublicPluginSdkEntrypoints.length}`,
    `deprecated barrel subpaths: ${deprecatedBarrelPluginSdkEntrypoints.length}`,
    `public wildcard reexports: ${report.publicWildcards.count}`,
    `package-exported forbidden subpaths: ${report.leakedForbiddenExports.length}`,
  ].join("\n");
}

async function main(argv: string[] = process.argv.slice(2), env = process.env) {
  const cliArgs = parsePluginSdkSurfaceReportArgs(argv);
  if (cliArgs.help) {
    process.stdout.write(usage());
    return 0;
  }
  const budgetConfig = readPluginSdkSurfaceBudgets(env);
  const inventory = cliArgs.check
    ? parsePluginSdkShippedSurface(
        JSON.parse(fs.readFileSync(path.join(repoRoot, shippedSurfacePath), "utf8")),
      )
    : undefined;
  if (inventory) {
    const tags = execFileSync("git", ["tag", "--list", "v*"], { cwd: repoRoot, encoding: "utf8" })
      .trim()
      .split("\n");
    const newer = tags
      .filter((tag) => isStableRelease(tag) && compareStableReleases(tag, inventory.release) > 0)
      .toSorted(compareStableReleases)
      .at(-1);
    if (newer) {
      process.stderr.write(
        `WARNING: shipped Plugin SDK inventory ${inventory.release} is older than local stable tag ${newer}. Run pnpm plugin-sdk:shipped-surface:gen -- --release ${newer} after stable release closeout.\n`,
      );
    }
  }
  const report = await collectPluginSdkSurfaceReport();
  process.stdout.write(`${renderPluginSdkSurfaceReport(report)}\n`);
  const failures = evaluatePluginSdkSurfaceReport(report, budgetConfig);
  if (inventory) {
    const shippedFailures = evaluatePluginSdkShippedSurface(
      inventory,
      report.typedPublicSurface,
      listPluginCompatRecords(),
      env.OPENCLAW_PLUGIN_SDK_SURFACE_NOW ?? new Date().toISOString().slice(0, 10),
    );
    failures.push(...formatPluginSdkShippedSurfaceFailures(inventory, shippedFailures));
    if (shippedFailures.length === 0) {
      process.stdout.write(`shipped Plugin SDK ${inventory.release}: no unauthorized removals\n`);
    }
  }
  if (cliArgs.check && failures.length > 0) {
    process.stderr.write(`plugin SDK surface check failed:\n`);
    for (const failure of failures) {
      process.stderr.write(`- ${failure}\n`);
    }
    return 1;
  }
  return 0;
}

const isMain =
  typeof process.argv[1] === "string" &&
  process.argv[1].length > 0 &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  try {
    process.exitCode = await main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
