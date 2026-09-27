#!/usr/bin/env node

// Reports plugin SDK export surface metadata.
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
} from "typescript/unstable/sync";
import { booleanFlag, parseFlagArgs } from "./lib/arg-utils.mts";
import { formatNativeTypeScriptDiagnostics } from "./lib/native-typescript-diagnostics.mts";
import { createNativeTypeScriptProject } from "./lib/native-typescript.mts";
import {
  deprecatedBarrelPluginSdkEntrypoints,
  deprecatedPublicPluginSdkEntrypoints,
  packagedPrivatePluginSdkRuntimeEntrypoints,
  pluginSdkEntrypoints,
  privateLocalOnlyPluginSdkEntrypoints,
  publicPluginSdkEntrypoints,
} from "./lib/plugin-sdk-entries.mts";
import { resolveRepoRoot } from "./lib/repo-root.mjs";

const repoRoot = resolveRepoRoot(import.meta.url);

type ExportEntryStats = {
  callableExports: number;
  deprecatedCallableExports: number;
  deprecatedExports: number;
  exports: number;
};

function usage() {
  return `Usage: node --import tsx scripts/plugin-sdk-surface-report.mts [--check]

Reports plugin SDK export surface metadata.

Options:
  --check     Fail when SDK surface budgets are exceeded.
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
  core: 3,
  "plugin-entry": 1,
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
  "config-runtime": 115,
  "config-contracts": 0,
  "inbound-reply-dispatch": 24,
  "channel-reply-pipeline": 12,
  "interactive-runtime": 11,
  // +3: canonical incognito classifier projected through deprecated compatibility barrels.
  "infra-runtime": 596,
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
  "agent-harness": 2,
  "agent-harness-runtime": 10,
  "command-auth": 78,
  discord: 47,
  // +4: deprecated media projection type, builder, and turn aliases.
  "channel-inbound": 18,
  "channel-lifecycle": 23,
  // +1: shared ingress error factory projected through the deprecated message barrel.
  // +1: shared ingress retention defaults projected through the deprecated message barrel.
  // +1: WhatsApp ack-policy bridge counted through the channel-message legacy facade.
  // Rendering helpers also remain available through this shipped legacy facade.
  "channel-message": 136,
  // +2: Slack progress-draft render bridge (function + mode type).
  "channel-outbound": 2,
  // +2: WhatsApp ack-policy bridge (function + mode type).
  "channel-feedback": 2,
  "channel-pairing": 0,
  "channel-policy": 7,
  "channel-send-result": 1,
  "reply-runtime": 1,
  "security-runtime": 1,
  "session-store-runtime": 4,
  // +2: shipped Slack and Discord setup helpers retained through their package migration window.
  "setup-runtime": 2,
  "reply-history": 6,
  "provider-auth": 19,
  "telegram-account": 3,
} satisfies Record<string, number>);

export function readPluginSdkSurfaceBudgets(env: NodeJS.ProcessEnv = process.env) {
  const budgets = {
    publicEntrypoints: readPluginSdkSurfaceBudgetEnv(
      "OPENCLAW_PLUGIN_SDK_MAX_PUBLIC_ENTRYPOINTS",
      158,
      env,
    ),
    publicExports: readPluginSdkSurfaceBudgetEnv(
      "OPENCLAW_PLUGIN_SDK_MAX_PUBLIC_EXPORTS",
      4590,
      env,
    ),
    publicFunctionExports: readPluginSdkSurfaceBudgetEnv(
      "OPENCLAW_PLUGIN_SDK_MAX_PUBLIC_FUNCTION_EXPORTS",
      2694,
      env,
    ),
    publicDeprecatedExports: readPluginSdkSurfaceBudgetEnv(
      "OPENCLAW_PLUGIN_SDK_MAX_PUBLIC_DEPRECATED_EXPORTS",
      1139,
      env,
    ),
    publicWildcardReexports: readPluginSdkSurfaceBudgetEnv(
      "OPENCLAW_PLUGIN_SDK_MAX_PUBLIC_WILDCARD_REEXPORTS",
      47,
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

function hasDeprecatedTag(checker: Checker, symbol: Symbol) {
  return checker.getJsDocTagsOfSymbol(symbol).some((tag) => tag.name === "deprecated");
}

function isCallableExport(checker: Checker, symbol: Symbol, sourceFile: ts.SourceFile) {
  const target = unwrapAlias(checker, symbol);
  const declaration =
    target.valueDeclaration?.resolve() ?? target.declarations[0]?.resolve() ?? sourceFile;
  const type = checker.getTypeOfSymbolAtLocation(target, declaration);
  return checker.getSignaturesOfType(type, SignatureKind.Call).length > 0;
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

function collectExportStats(project: Project, entrypoints: string[]) {
  const { program, checker } = project;
  const byEntrypoint = new Map<string, ExportEntryStats>();

  for (const entrypoint of entrypoints) {
    const sourceFile = program.getSourceFile(entrypointPath(entrypoint));
    if (!sourceFile) {
      byEntrypoint.set(entrypoint, {
        exports: 0,
        callableExports: 0,
        deprecatedExports: 0,
        deprecatedCallableExports: 0,
      });
      continue;
    }
    const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
    const symbols = moduleSymbol ? checker.getExportsOfModule(moduleSymbol) : [];
    let callableExports = 0;
    let deprecatedExports = 0;
    let deprecatedCallableExports = 0;
    const deprecatedEntrypoint = deprecatedPublicEntrypointSet.has(entrypoint);
    for (const symbol of symbols) {
      const callable = isCallableExport(checker, symbol, sourceFile);
      const deprecated =
        deprecatedEntrypoint ||
        hasDeprecatedTag(checker, symbol) ||
        hasDeprecatedTag(checker, unwrapAlias(checker, symbol));
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
      callableExports,
      deprecatedExports,
      deprecatedCallableExports,
    });
  }

  return byEntrypoint;
}

function selectExportStats(
  scannedStats: ReturnType<typeof collectExportStats>,
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
  byEntrypoint: ReturnType<typeof collectExportStats>,
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

export function collectPluginSdkSurfaceReport() {
  const scannedEntrypoints = [
    ...new Set([
      ...pluginSdkEntrypoints,
      ...publicPluginSdkEntrypoints,
      ...privateLocalOnlyPluginSdkEntrypoints,
    ]),
  ];
  // All inventories share one native graph; its handles never escape this report.
  const configFileName = path.join(repoRoot, "tsconfig.plugin-sdk-surface-report.json");
  const session = createNativeTypeScriptProject({
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
    const diagnostics = session.project.program.getConfigFileParsingDiagnostics();
    if (diagnostics.length) {
      throw new Error(formatNativeTypeScriptDiagnostics(diagnostics));
    }
    const scannedStats = collectExportStats(session.project, scannedEntrypoints);
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
    const deprecatedBarrelWithoutReexports = [...deprecatedBarrelEntrypointSet].filter(
      (entrypoint) => {
        const source = session.project.program.getSourceFile(entrypointPath(entrypoint));
        // Frozen facades retain named reexports without inheriting new APIs through a wildcard.
        return !source?.statements.some(
          (statement) =>
            ts.isExportDeclaration(statement) &&
            statement.moduleSpecifier !== undefined &&
            (!statement.exportClause ||
              ts.isNamespaceExport(statement.exportClause) ||
              statement.exportClause.elements.length > 0),
        );
      },
    );
    return {
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
    session.close();
  }
}

export function evaluatePluginSdkSurfaceReport(
  report: ReturnType<typeof collectPluginSdkSurfaceReport>,
  {
    budgets,
    publicDeprecatedExportsByEntrypointBudget,
  }: ReturnType<typeof readPluginSdkSurfaceBudgets>,
) {
  const failures: string[] = [];
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

function renderPluginSdkSurfaceReport(report: ReturnType<typeof collectPluginSdkSurfaceReport>) {
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

function main(argv: string[] = process.argv.slice(2), env = process.env) {
  const cliArgs = parsePluginSdkSurfaceReportArgs(argv);
  if (cliArgs.help) {
    process.stdout.write(usage());
    return 0;
  }
  const budgetConfig = readPluginSdkSurfaceBudgets(env);
  const report = collectPluginSdkSurfaceReport();
  process.stdout.write(`${renderPluginSdkSurfaceReport(report)}\n`);
  const failures = evaluatePluginSdkSurfaceReport(report, budgetConfig);
  if (cliArgs.check && failures.length > 0) {
    process.stderr.write(`plugin SDK surface budget failed:\n`);
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
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
