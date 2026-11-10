import { agentVitestProjectOwners } from "../../test/vitest/vitest.agents-paths.mjs";
import { databaseWorkerCoreTestFiles } from "../../test/vitest/vitest.database-worker-core-paths.mjs";
import {
  loadPatternListFromEnv,
  matchesVitestCliSelection,
} from "../../test/vitest/vitest.pattern-file.ts";
import {
  includesRuntimeConfig,
  resolveVitestRuntimeConfigScopes,
  type VitestRuntimeTestSelection,
} from "./vitest-build-prerequisites.mts";
import { collectVitestFileFilters } from "./vitest-cli-mode.mts";
import type { VitestWorkerPreset } from "./vitest-worker-descriptor.mts";

export const TUI_PTY_BUILT_CLI_CANARY_PATTERN =
  "launches openclaw chat as local mode through a real PTY";

// These built-CLI proofs still read source owners, but their only compiled
// declarations belong to the production runtime registry.
const runtimeOnlyBuiltCliFiles = new Set([
  "extensions/browser/src/browser/extension-install.native-host.e2e.test.ts",
  "test/e2e/qa-lab/plugins/discord-show-widget-contextual-presenter.e2e.test.ts",
  "test/scripts/doctor-config-preflight-plugin-index.built-cli.e2e.test.ts",
  "test/scripts/sqlite-sessions-transcripts-flip-proof.built-cli.e2e.test.ts",
]);

// These selections need no compiled test-only fixtures.
const runtimeOnlyUnitFiles = new Set([
  "src/agents/agent-tools.delegated-authority.test.ts",
  "src/agents/session-placement-computer.test.ts",
  "src/agents/session-tool-result-guard.tool-result-persist-hook.test.ts",
  "src/agents/subagents/announce/subagent-announce.incognito.test.ts",
  "src/agents/subagents/spawn/subagent-spawn.production-boundary.test.ts",
  "src/auto-reply/reply/commands-system-prompt.test.ts",
  "src/auto-reply/reply/dispatch-acp.test.ts",
  "src/auto-reply/reply/dispatch-from-config.delivery.test.ts",
  "src/auto-reply/reply/dispatch-from-config.lifecycle.test.ts",
  "src/auto-reply/reply/dispatch-from-config.test.ts",
  "src/auto-reply/reply/followup-runner.test.ts",
  "src/auto-reply/reply/groups.test.ts",
  "src/config/io.load-async.test.ts",
  "src/gateway/client-callsites.guard.test.ts",
  "src/gateway/server-methods/session-catalog-privacy.test.ts",
  "src/gateway/server.beam-owned-view.test.ts",
  "src/gateway/talk/client-permission-parity.test.ts",
  "src/gateway/tool-resolution.swarm-collector.test.ts",
  "src/plugins/loader.runtime-registry.test.ts",
  "src/plugins/plugin-generation-source-inspection.worker.test.ts",
  "src/plugins/plugin-generation-worker.test.ts",
  "src/state/dreaming-startup-admission.test.ts",
  "test/canonical-descendant.integration.test.ts",
  "test/codex-account-usage.integration.test.ts",
  "test/codex-settled-turn-finalization.integration.test.ts",
  "test/codex-web-search-native.integration.test.ts",
  "test/codex-web-search-policy.integration.test.ts",
  "test/conversation-tools.codex.integration.test.ts",
  "test/cron-conversation-delivery.codex.integration.test.ts",
  "test/decision-tool.codex.integration.test.ts",
  "test/plugins/chat-abort-codex.gateway.test.ts",
  "test/plugins/codex-native-search.gateway.test.ts",
  "test/plugins/deep-research-routing.gateway.test.ts",
  "test/runtime-agent.codex-initialization.integration.test.ts",
  "test/scripts/ci-test-timings-tooling.test.ts",
  "test/scripts/eager-import-closure.test.ts",
  "test/scripts/lint-suppressions.test.ts",
  "test/scripts/plugin-sdk-surface-report.test.ts",
  "test/scripts/pr-wrapper-source-closure.test.ts",
  "test/scripts/type-suppression-inventory.test.ts",
  "test/skill-usage.codex.integration.test.ts",
  "test/slack-outbound-permanent-rejection-loopback.test.ts",
  "test/vitest-projects-config.test.ts",
]);

// These tooling proofs use compiled harness entries, not production workers.
const toolingOnlyUnitFiles = new Set([
  "test/scripts/vitest-prebuilt-ai.test.ts",
  "test/scripts/ci-changed-build-selection.test.ts",
  "test/scripts/ci-changed-node-test-plan.integration.test.ts",
  "test/scripts/vitest-worker-artifacts.batch.test.ts",
  "test/scripts/run-vitest-progress.test.ts",
  "test/scripts/run-vitest.test.ts",
  "test/scripts/extension-test-plan.test.ts",
  "test/scripts/test-extension.test.ts",
  "test/scripts/test-projects.test.ts",
  "test/scripts/plugin-sdk-surface-report.test.ts",
]);

/** A selection supported by both narrow graphs must retain its parent's graph. */
export function selectVitestWorkerPreset(
  runtimeOnly: boolean,
  toolingOnly: boolean,
  parent?: VitestWorkerPreset,
): VitestWorkerPreset {
  if (parent === "runtime" && runtimeOnly) {
    return "runtime";
  }
  return toolingOnly ? "tooling" : runtimeOnly ? "runtime" : "full";
}

/** Share the exact group decision between CI's archive hint and worker owner. */
export function resolveCiVitestWorkerPreset(
  plans: {
    target?: string;
    configs?: string[];
    includePatterns?: readonly string[] | null;
    requiresDist?: boolean;
    pretestBuildMode?: string;
    env?: NodeJS.ProcessEnv;
  }[],
  hasExtraArgs = false,
): VitestWorkerPreset {
  const supports = (
    files: typeof areRuntimeOnlyVitestUnitFiles,
    selection: typeof shouldUseRuntimeOnlyVitestWorkers,
  ) =>
    !hasExtraArgs &&
    plans.length > 0 &&
    plans.every((plan) =>
      plan.target !== undefined
        ? files([plan.target])
        : plan.configs?.length === 1 &&
          Boolean(plan.includePatterns?.length) &&
          !plan.requiresDist &&
          plan.pretestBuildMode === undefined &&
          selection(
            plan.configs[0]!,
            [],
            plan.env ?? {},
            undefined,
            plan.includePatterns ?? undefined,
          ),
    );
  return selectVitestWorkerPreset(
    supports(areRuntimeOnlyVitestUnitFiles, shouldUseRuntimeOnlyVitestWorkers),
    supports(areToolingOnlyVitestUnitFiles, shouldUseToolingOnlyVitestWorkers),
  );
}

function areToolingOnlyVitestUnitFiles(files: readonly string[]): boolean {
  return files.length > 0 && files.every((file) => toolingOnlyUnitFiles.has(file));
}

function selectedFiles(
  args: string[],
  env: NodeJS.ProcessEnv,
  includePatterns?: readonly string[],
) {
  return (
    includePatterns ??
    loadPatternListFromEnv("OPENCLAW_VITEST_INCLUDE_FILE", env) ??
    collectVitestFileFilters(args)
  ).map((file) => file.replaceAll("\\", "/").replace(/^\.\//u, ""));
}

export function shouldUseToolingOnlyVitestWorkers(
  config: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  _testNamePattern?: string | RegExp,
  includePatterns?: readonly string[],
): boolean {
  return (
    config === "test/vitest/vitest.tooling.config.ts" &&
    areToolingOnlyVitestUnitFiles(selectedFiles(args, env, includePatterns))
  );
}

function areRuntimeOnlyVitestUnitFiles(files: readonly string[]): boolean {
  return files.length > 0 && files.every((file) => runtimeOnlyUnitFiles.has(file));
}

/** Broad or mixed selections retain the complete test-fixture compiler graph. */
export function shouldUseRuntimeOnlyVitestWorkers(
  config: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  testNamePattern?: string | RegExp,
  includePatterns?: readonly string[],
): boolean {
  const files = selectedFiles(args, env, includePatterns);
  if (files.length === 0) {
    return false;
  }
  if (config === "test/vitest/vitest.e2e.config.ts") {
    return files.every((file) => runtimeOnlyBuiltCliFiles.has(file));
  }
  if (
    (config === "test/vitest/vitest.agents-core.config.ts" ||
      config === "test/vitest/vitest.agents-spawn-production-boundary.config.ts" ||
      config === "test/vitest/vitest.auto-reply.config.ts" ||
      config === "test/vitest/vitest.auto-reply-reply.config.ts" ||
      config === "test/vitest/vitest.infra.config.ts" ||
      config === "test/vitest/vitest.runtime-config.config.ts" ||
      config === "test/vitest/vitest.plugins.config.ts" ||
      config === "test/vitest/vitest.tooling.config.ts" ||
      config === "test/vitest/vitest.tooling-isolated.config.ts" ||
      config === "test/vitest/vitest.unit-fast.config.ts" ||
      config === "test/vitest/vitest.unit-fast-isolated.config.ts" ||
      config === "test/vitest/vitest.gateway-client.config.ts" ||
      config === "test/vitest/vitest.gateway-database-workers.config.ts" ||
      config === "test/vitest/vitest.gateway-methods.config.ts" ||
      config === "test/vitest/vitest.gateway-server.config.ts") &&
    areRuntimeOnlyVitestUnitFiles(files)
  ) {
    return true;
  }
  const pattern = typeof testNamePattern === "string" ? testNamePattern : testNamePattern?.source;
  // Only the built CLI canaries avoid the native-owner fixture graph.
  return (
    config === "test/vitest/vitest.tui-pty.config.ts" &&
    env.OPENCLAW_TUI_PTY_USE_BUILT_CLI === "1" &&
    pattern === TUI_PTY_BUILT_CLI_CANARY_PATTERN &&
    files.every((file) => file === "src/tui/tui-pty-local.e2e.test.ts")
  );
}

/** Bind installed CLI matching without adding runtime dependencies to CI planning. */
export function resolveVitestRuntimeCliSelections(
  config: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): VitestRuntimeTestSelection[] {
  return resolveVitestRuntimeConfigScopes(config).map(({ file: scopedFile, configs, dir }) => ({
    configs,
    matchesFile: (file, included, includePatterns) =>
      file === scopedFile &&
      matchesVitestCliSelection(file, included ? [file] : [], args, dir, env, includePatterns),
  }));
}

/** Keep known worker compilation outside dynamically imported test cases. */
export function shouldPrepareVitestCoreWorkers(
  config: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  includePatterns?: readonly string[] | null,
): boolean {
  // Prepare broad native-declaration projects before the test watchdog starts.
  if (
    [
      "test/vitest/vitest.channels.config.ts",
      "test/vitest/vitest.gateway-methods.config.ts",
    ].includes(config) &&
    collectVitestFileFilters(args).length === 0 &&
    includePatterns == null &&
    !env.OPENCLAW_VITEST_INCLUDE_FILE?.trim()
  ) {
    return true;
  }
  const configs = [config];
  const workers = [
    ...(includesRuntimeConfig(configs, "test/vitest/vitest.infra.config.ts")
      ? databaseWorkerCoreTestFiles
      : []),
    ...(includesRuntimeConfig(configs, "test/vitest/vitest.contracts-plugin.config.ts")
      ? ["src/plugins/contracts/plugin-sdk-package-contract-guardrails.test.ts"]
      : []),
    ...(includesRuntimeConfig(configs, "test/vitest/vitest.e2e.config.ts")
      ? ["test/e2e/gateway-transcripts-discord-capture.e2e.test.ts"]
      : []),
  ];
  const gatewayStartupWorkers = [
    "src/gateway/server-runtime-subscriptions.test.ts",
    "src/gateway/server-runtime-config.test.ts",
  ];
  const codeModeWorker = "src/agents/code-mode.import-boundary.test.ts";
  return (
    workers.some((file) =>
      matchesVitestCliSelection(file, [file], args, "", env, includePatterns),
    ) ||
    // These focused startup selections need native stores before their watchdog starts.
    // Match their project directory so basename filters and exclusions keep working.
    (includesRuntimeConfig(configs, "test/vitest/vitest.gateway-server.config.ts") &&
      gatewayStartupWorkers.some((file) =>
        matchesVitestCliSelection(file, [file], args, "src/gateway", env, includePatterns),
      )) ||
    ((includesRuntimeConfig(configs, agentVitestProjectOwners.core.config) ||
      includesRuntimeConfig(configs, agentVitestProjectOwners.all.config)) &&
      matchesVitestCliSelection(
        codeModeWorker,
        [codeModeWorker],
        args,
        agentVitestProjectOwners.core.dir,
        env,
        includePatterns,
      ))
  );
}
