import { agentVitestProjectOwners } from "../../test/vitest/vitest.agents-paths.mjs";
import { databaseWorkerCoreTestFiles } from "../../test/vitest/vitest.database-worker-core-paths.mjs";
import { matchesVitestCliSelection } from "../../test/vitest/vitest.pattern-file.ts";
import {
  includesRuntimeConfig,
  resolveVitestRuntimeConfigScopes,
  type VitestRuntimeTestSelection,
} from "./vitest-build-prerequisites.mts";
import { collectVitestFileFilters } from "./vitest-cli-mode.mts";

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

/** Broad or mixed selections retain the complete test-fixture compiler graph. */
export function shouldUseRuntimeOnlyVitestWorkers(
  config: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  testNamePattern?: string | RegExp,
): boolean {
  const files = collectVitestFileFilters(args).map((file) =>
    file.replaceAll("\\", "/").replace(/^\.\//u, ""),
  );
  if (files.length === 0) {
    return false;
  }
  if (config === "test/vitest/vitest.e2e.config.ts") {
    return files.every((file) => runtimeOnlyBuiltCliFiles.has(file));
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
