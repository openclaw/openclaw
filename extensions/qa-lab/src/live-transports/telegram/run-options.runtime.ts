import path from "node:path";
import type { LiveTransportQaCommandOptions } from "openclaw/plugin-sdk/qa-runtime";
import { resolveRepoRelativeOutputDir } from "../../cli-paths.js";
import { DEFAULT_QA_LIVE_PROVIDER_MODE } from "../../providers/index.js";
import type { QaProviderMode } from "../../run-config.js";
import { normalizeQaProviderMode } from "../../run-config.js";

export function resolveTelegramQaRunOptions(
  opts: LiveTransportQaCommandOptions,
): LiveTransportQaCommandOptions & {
  repoRoot: string;
  providerMode: QaProviderMode;
} {
  const credentialSource = opts.credentialSource?.trim().toLowerCase() || "convex";
  if (credentialSource !== "convex") {
    throw new Error("Telegram QA supports only --credential-source convex.");
  }
  const repoRoot = path.resolve(opts.repoRoot ?? process.cwd());
  return {
    repoRoot,
    outputDir: resolveRepoRelativeOutputDir(repoRoot, opts.outputDir),
    providerMode:
      opts.providerMode === undefined
        ? DEFAULT_QA_LIVE_PROVIDER_MODE
        : normalizeQaProviderMode(opts.providerMode),
    primaryModel: opts.primaryModel?.trim() || undefined,
    alternateModel: opts.alternateModel?.trim() || undefined,
    fastMode: opts.fastMode,
    allowFailures: opts.allowFailures,
    failFast: opts.failFast,
    scenarioIds: opts.scenarioIds,
    listScenarios: opts.listScenarios,
    sutAccountId: opts.sutAccountId,
    credentialFile: opts.credentialFile,
    credentialSource,
    credentialRole: opts.credentialRole?.trim(),
  };
}
