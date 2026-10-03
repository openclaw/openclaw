import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { HealthCheck, HealthFinding } from "openclaw/plugin-sdk/health";
import type { OpenClawPluginService } from "openclaw/plugin-sdk/plugin-entry";
import {
  CODEX_NATIVE_PROFILE_IMPORT_COMMAND,
  formatCodexAuthProfileUnavailableMessage,
} from "./app-server/auth-profile-recovery.js";

const CHECK_ID = "codex/native-profile-recovery";
const PROFILE_ID = "openai:default";

async function collectFindings(
  config: OpenClawConfig,
  env: NodeJS.ProcessEnv,
): Promise<HealthFinding[]> {
  const declared = config.auth?.profiles?.[PROFILE_ID];
  if (declared?.provider !== "openai" || declared.mode !== "oauth") {
    return [];
  }
  const [{ loadAuthProfileStoreForRuntime }, { listAgentIds, resolveAgentDir }] = await Promise.all(
    [
      import("openclaw/plugin-sdk/agent-runtime"),
      import("openclaw/plugin-sdk/agent-scope-runtime"),
    ],
  );
  const findings: HealthFinding[] = [];
  const missing: string[] = [];
  for (const agentId of listAgentIds(config)) {
    try {
      const store = loadAuthProfileStoreForRuntime(
        resolveAgentDir(config, agentId, env),
        { readOnly: true, config, externalCli: { mode: "none" } },
        env,
      );
      if (!store.profiles[PROFILE_ID]) {
        missing.push(agentId);
      }
    } catch (error) {
      findings.push({
        checkId: CHECK_ID,
        source: "codex",
        severity: "warning",
        message: `Could not inspect OpenAI auth profiles for agent "${agentId}": ${error instanceof Error ? error.message : String(error)}`,
        fixHint: "openclaw doctor --fix",
      });
    }
  }
  if (missing.length > 0) {
    findings.push({
      checkId: CHECK_ID,
      source: "codex",
      severity: "warning",
      message: `${formatCodexAuthProfileUnavailableMessage(PROFILE_ID)} Affected agents: ${missing.join(", ")}.`,
      fixHint: CODEX_NATIVE_PROFILE_IMPORT_COMMAND,
    });
  }
  return findings;
}

export const codexNativeProfileRecoveryHealthCheck: HealthCheck = {
  id: CHECK_ID,
  kind: "plugin",
  source: "codex",
  description: "Explain recovery for a configured profile formerly supplied by native Codex login.",
  detect: (ctx) => collectFindings(ctx.cfg, ctx.env ?? process.env),
};

export const codexNativeProfileRecoveryService: OpenClawPluginService = {
  id: CHECK_ID,
  async start(ctx) {
    const findings = await collectFindings(ctx.config, {
      ...process.env,
      OPENCLAW_STATE_DIR: ctx.stateDir,
    });
    for (const finding of findings) {
      ctx.logger.warn(finding.message);
    }
  },
};
