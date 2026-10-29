#!/usr/bin/env node

// Reports plugin SDK export surface metadata.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import * as ts from "typescript/ast";
import {
  SignatureKind,
  SymbolFlags,
  type Checker,
  type Project,
  type Symbol,
} from "typescript/async";
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
  "proxy-capture": 10,
  routing: 1,
  // +4: shipped default/session-agent resolvers remain available through
  // compatibility barrels while callers migrate to explicit/sole selection.
  health: 1,
  "agent-scope-runtime": 4,
  // +1: shipped channel setup state-migration declaration during its migration window.
  "channel-entry-contract": 1,
  "approval-gateway-runtime": 1,
  // Complete the approved synchronous approval-preparation deprecations.
  "approval-handler-runtime": 3,
  "approval-handler-adapter-runtime": 1,
  "approval-reply-runtime": 0,
  // Released synchronous approval routing remains until a later release after stable deprecation.
  "approval-client-runtime": 1,
  "approval-delivery-runtime": 2,
  "approval-native-runtime": 11,
  "approval-runtime": 8,
  "config-contracts": 0,
  // +1: getRuntimeConfig keeps its shipped cold-load contract while callers prepare
  // with captureRuntimeConfigAsyncReader and consume readRuntimeConfig.
  "runtime-config-snapshot": 1,
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
  // +7: released auth-store and TTS methods retain synchronous compatibility.
  // +3: loadAuthProfileStoreForSecretsRuntime -> loadAuthProfileStoreForRuntimeAsync
  // with readOnly:true and allowKeychainPrompt:false; saveAuthProfileStore ->
  // provider-auth.updateAuthProfileStoreWithLock. resolveAuthStorePathForDisplay
  // stays compatible; its resolveAuthStorePathForDisplayAsync replacement is core-internal.
  // +1: released snapshot publication remains during its approved async replacement.
  "agent-runtime": 15,
  "memory-host-core": 2,
  // +4: session-write lease no-op compatibility stubs through the 2026.10 train.
  // +4: legacy AgentHarness, attempt, embedded-run, and side-question contracts remain
  // deprecated while external harnesses migrate to required-capability V2 contracts.
  // +1: bounded structured-input compiler/executor for native harness protocol adapters.
  // +1: owner-approved async tool construction retains the deprecated synchronous factory.
  "agent-harness": 3,
  // +1: owner-approved synchronous watched-session compatibility during async migration.
  // +1: owner-approved synchronous agent-end compatibility during async migration.
  // +1: synchronous model-auth selection during the auth worker migration.
  "agent-harness-runtime": 13,
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
  // Released synchronous conversation binding APIs remain until a later release after stable deprecation.
  "conversation-binding-inspection-runtime": 1,
  "conversation-runtime": 3,
  "channel-send-result": 1,
  "reply-runtime": 1,
  "security-runtime": 1,
  // +2: approved released upstream-link writes retained during worker migration.
  "session-catalog": 2,
  // +2: released synchronous transcript event/stat reads during the worker cutover.
  "session-store-runtime": 10,
  // Released synchronous sandbox lookup remains while plugins adopt async or prepared reads.
  sandbox: 1,
  // +2: shipped Slack and Discord setup helpers retained through their package migration window.
  "setup-runtime": 2,
  "reply-history": 6,
  // +7: released auth read/write/availability helpers during async migration.
  "provider-auth": 22,
  "models-provider-runtime": 1,
  // Released synchronous command discovery remains while plugins adopt worker-backed preparation.
  "command-auth-native": 4,
  "native-command-registry": 1,
  "skill-commands-runtime": 2,
  // +1: createSessionHeaderLink from shipped 2026.10.1 until plugin-sdk-session-header-link expires.
  "control-ui": 1,
} satisfies Record<string, number>);

export function readPluginSdkSurfaceBudgets(env: NodeJS.ProcessEnv = process.env) {
  const budgets = {
    publicEntrypoints: readPluginSdkSurfaceBudgetEnv(
      "OPENCLAW_PLUGIN_SDK_MAX_PUBLIC_ENTRYPOINTS",
      // +1: the shared state-owner boundary for plugin CLIs.
      // +1: owner-approved service-bound remote Control UI ingress.
      // +2: shared database-engine host and worker adapters.
      // +1: maintainer-requested context-engine-transcript-runtime watermark subpath (2026-10-08).
      // +1: approved shared OpenAI Decisions codec used by OpenAI and ClawRouter.
      // +1: approved lightweight nullable request-header projection for provider transports.
      // +1: approved shared automation tool-default selection before policy and approval.
      159,
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
      // +1: requester-bound transport effects for owner-routed plugin commands.
      // +18: remote Control UI ingress V1/V2 types and typed admission error.
      // +5: approved sync-to-async replacements: inspectConversationBinding,
      // resolveCommandAuthorization, createApproverRestrictedNativeApprovalCapability,
      // createChannelApprovalNativeRuntimeAdapter, and createLazyChannelApprovalNativeRuntimeAdapter.
      // +1: approved final-delivery capture ownership predicate for channel transcript mirrors.
      // +7: approved GitHub publication V2 requester/action contracts: five types and two preparers.
      // +3: approved async skill-command preparation pairs on two existing entrypoints.
      // +15: approved async auth, model, and TTS replacement pairs.
      // +7: approved async session, command-menu, model-override, TTS-path, and list replacements.
      // +1: preview adapters strip only normalization-owned response decoration.
      // +1: shared stale-read cache replaces board, preview, search, and credential cache policies.
      // +24: approved async approval-routing replacements and delivery facts across four public facades.
      // +2: async sandbox lookup and pure prepared-session classification.
      // +1: deprecated createSessionHeaderLink retained from shipped 2026.10.1.
      // +2: approved async transcript event/stat read replacements.
      // +1: approved PreparedAgentRunStart contract.
      // +2: readRuntimeConfig and captureRuntimeConfigAsyncReader on runtime-config-snapshot.
      // +10: shared database-engine contracts and operations after the SQLite export cutover.
      // +1: approved async auth-snapshot publication with retained sync compatibility.
      // +1: approved lexical database-engine admission scope for workboard boot/migrations.
      // +1: async auth-provider preparation for Codex and voice model-session patches.
      // +1: isHostNoticePayload for agent-to-agent reply filtering.
      // +1: approved jsonPathValue on the experimental database-engine worker entrypoint.
      // +11: approved experimental engine-owned search capabilities on existing entrypoints.
      // +14: versioned Decision data contracts, lossless codecs, validation, and typed errors.
      // +4: Decision execution/context types; completes Peter Steinberger's
      // approved +18 exports / +6 callables scope (2026-09-26, #157148 and #157225).
      // +1: approved boot-selected family lookup on the database-engine runtime.
      // +1: shared auth-patch application replaces manual plugin config merging.
      // +6: packaged Settings placement, snapshot, components, context, view, and
      // DoctorMemoryStatusPayload for the plugin-owned Memory overview.
      // +2: MemorySearchResponse and AgentsWorkspaceGetResult type-only contracts
      // for the plugin-owned indexed Memory search presentation.
      // +5: maintainer-requested context-engine transcript watermark reader, its types, and fence error.
      // +3: ControlUiChannelSettingsSnapshot, ControlUiChannelSettingsContext, and
      // ControlUiChannelSettingsView for plugin-owned channel Settings presentations.
      // +1: the shared message-tool source-reply finality resolver.
      // +1: awaited web_search policy preparation for harnesses; the sync resolver stays.
      // +3: shared Decisions support/evaluation functions and the canonical capability schema.
      // +2: openRecord and ToolArgumentValidationError on the existing tool-plugin facade.
      // +1: resolveManagedResourceStateDir keeps plugin-managed model caches and binaries on the operator root during redirected agent exec.
      // +2: shared SystemOne question encoder and response decoder on the Decisions facade.
      // +4: capability-aware auth context and transport model types in core/plugin-entry.
      // +2: the shared automation tool-default resolver and its exact-selection mode type.
      3824,
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
      // +1: runWithLocalStateMutationOwner shares the existing transport authority scope.
      // +5: the five awaited inspection, authorization, and approval factory replacements above.
      // +1: the same final-delivery capture ownership predicate.
      // +2: prepareGitHubPublicationRequesterV2 and preparePersonalGitHubSessionActionV2.
      // +3: the same skill-command preparation replacements.
      // +15: the same auth, model, and TTS replacement pairs.
      // +7: the same session, command-menu, model-override, TTS-path, and list replacements.
      // +1: stripReplyPayloadResponsePrefix preserves durable text while assembling previews.
      // +1: the same bounded stale-read cache factory on collection-runtime.
      // +22: the same async approval-routing functions; two delivery-fact exports are types.
      // +2: the same sandbox replacements.
      // +1: the same deprecated createSessionHeaderLink.
      // +2: the same transcript read replacement pairs.
      // +2: the same prepared runtime reader and asynchronous config preparation functions.
      // +5: shared database-engine host and worker operations.
      // +1: approved async auth-snapshot publication with retained sync compatibility.
      // +1: the same lexical database-engine admission scope.
      // +1: the same prepareAuthProfileProvider operation on model-session-runtime.
      // +1: the same host-notice classifier on reply-payload.
      // +1: the same approved database-engine JSON path helper.
      // +1: the same engine-owned search admission helper.
      // +6: four lossless Decision codecs and two bounded V2 validators.
      // +1: the same boot-selected family lookup.
      // +1: the same shared auth-patch application.
      // +1: maintainer-requested context-engine transcript watermark reader.
      // +1: the shared message-tool source-reply finality resolver, so harnesses apply a run's default.
      // +1: the same awaited web_search policy preparation.
      // +2: the same shared Decisions support predicate and evaluator.
      // +1: the same openRecord helper; ToolArgumentValidationError is construct-only.
      // +1: resolveManagedResourceStateDir keeps plugin-managed model caches and binaries on the operator root during redirected agent exec.
      // +2: the same shared SystemOne codec functions.
      // +1: the same shared automation tool-default resolver.
      2215,
      env,
    ),
    publicDeprecatedExports: readPluginSdkSurfaceBudgetEnv(
      "OPENCLAW_PLUGIN_SDK_MAX_PUBLIC_DEPRECATED_EXPORTS",
      // Remove deprecated sync channel envelope helpers and their compat records in a later release after stable deprecation.
      // +2: approved synchronous upstream-link write compatibility until a later release after stable deprecation.
      // +1: synchronous session entry getter remains until a later release after stable deprecation.
      // +6: released session callbacks and provider replay contracts during async migration.
      // +4: released synchronous conversation binding contracts during V2 migration.
      // +3: released synchronous skill-command list helpers during async migration.
      // +15: retained synchronous auth, model, and TTS compatibility exports.
      // +7: retained synchronous session, command-menu, model-override, TTS-path, and list exports.
      // +17: eleven synchronous approval-routing APIs retained across four public facades.
      // +1: released synchronous sandbox lookup retained until a later release after stable deprecation.
      // +1: createSessionHeaderLink from shipped 2026.10.1 until plugin-sdk-session-header-link expires.
      // +2: retained synchronous transcript event/stat reads until a later release after stable deprecation.
      // +4: the runtime config getter and three auth/store compatibility pairs named above.
      // +10: approved missing deprecations for retained synchronous transcript lookup,
      // proxy initialization, approval preparation, and command authorization.
      // +1: released snapshot publication remains during its approved async replacement.
      219,
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
