import path from "node:path";
import { resolveDefaultModelForAgent } from "openclaw/plugin-sdk/agent-runtime";
import { listAgentIds, resolveAgentDir } from "openclaw/plugin-sdk/agent-scope-runtime";
import { resolveEffectiveAgentRuntime } from "openclaw/plugin-sdk/command-auth-native";
import { coerceErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type {
  HealthCheck,
  HealthCheckContext,
  HealthFinding,
  PluginRuntimeMaintenanceContextV1,
} from "openclaw/plugin-sdk/health";
import { commandProcessCleanup } from "openclaw/plugin-sdk/process-runtime";
import { resolveCodexAppServerLocalHomeDir } from "./app-server/auth-start-options.js";
import { codexConfigEnablesNativeComputerUse } from "./app-server/config-reviewer-policy.js";
import {
  resolveCodexAppServerRuntimeOptions,
  resolveCodexAppServerStartOptionsForAgent,
  resolveCodexComputerUseConfig,
} from "./app-server/config.js";
import {
  resolveMacOSDesktopCodexAppPathCandidateForBundle,
  resolveMacOSDesktopCodexAppPathCandidates,
} from "./app-server/desktop-app-paths.js";
import { updateCodexDesktopApp } from "./app-server/desktop-app-update.js";
import {
  probeCodexDesktopRuntime,
  type CodexDesktopRuntimeProbeAgent,
} from "./app-server/desktop-runtime-probe.js";
import { resolveManagedCodexAppServerStartOptions } from "./app-server/managed-binary.js";

const CHECK_ID = "codex/selected-desktop-runtime";

type DesktopTarget = {
  appBundlePath: string;
  agents: CodexDesktopRuntimeProbeAgent[];
};

type MaintenanceDependencies = {
  platform?: NodeJS.Platform;
  resolveCommand?: typeof resolveManagedCodexAppServerStartOptions;
  updateApp?: typeof updateCodexDesktopApp;
  probe?: typeof probeCodexDesktopRuntime;
};

function finding(target: DesktopTarget, message: string): HealthFinding {
  return {
    checkId: CHECK_ID,
    source: "codex",
    severity: "warning",
    path: target.appBundlePath,
    message,
    fixHint: "Run openclaw plugins update codex to retry selected-runtime maintenance.",
  };
}

/** Fresh operation-owned checks, never registered in the process-wide Doctor registry. */
export function createCodexRuntimeMaintenanceChecks(
  operation: PluginRuntimeMaintenanceContextV1,
  deps: MaintenanceDependencies = {},
): readonly HealthCheck[] {
  if ((deps.platform ?? process.platform) !== "darwin") {
    return [];
  }
  const assertCurrent = () => {
    operation.signal.throwIfAborted();
    operation.assertCurrent();
  };
  const probe = deps.probe ?? probeCodexDesktopRuntime;
  const updateApp = deps.updateApp ?? updateCodexDesktopApp;
  const completed = new Set<string>();

  async function selectTargets(ctx: HealthCheckContext): Promise<DesktopTarget[]> {
    assertCurrent();
    const env = ctx.env ?? process.env;
    const pluginConfig = ctx.cfg.plugins?.entries?.codex?.config;
    const runtime = resolveCodexAppServerRuntimeOptions({ pluginConfig, env });
    if (runtime.start.transport !== "stdio" || runtime.start.commandSource !== "managed") {
      return [];
    }
    const computerUse = resolveCodexComputerUseConfig({ pluginConfig, env });
    const targets = new Map<string, DesktopTarget>();
    for (const agentId of listAgentIds(ctx.cfg)) {
      const model = resolveDefaultModelForAgent({ cfg: ctx.cfg, agentId });
      if (
        resolveEffectiveAgentRuntime({
          cfg: ctx.cfg,
          provider: model.provider,
          modelId: model.model,
          agentId,
        }) !== "codex"
      ) {
        continue;
      }
      const agentDir = resolveAgentDir(ctx.cfg, agentId, env);
      const start = resolveCodexAppServerStartOptionsForAgent({
        startOptions: runtime.start,
        agentDir,
        env,
      });
      const selected = await (deps.resolveCommand ?? resolveManagedCodexAppServerStartOptions)(
        start,
        { pluginRoot: operation.pluginRoot, env },
      );
      assertCurrent();
      const desktop =
        resolveMacOSDesktopCodexAppPathCandidates("darwin").find(
          (candidate) => candidate.appServerCommandPath === selected.command,
        ) ??
        resolveMacOSDesktopCodexAppPathCandidateForBundle(
          path.dirname(path.dirname(path.dirname(selected.command))),
          { platform: "darwin" },
        );
      // Package-only, explicit executables and remote servers keep their existing owners.
      if (!desktop || desktop.appServerCommandPath !== selected.command) {
        continue;
      }
      const target = targets.get(desktop.appBundlePath) ?? {
        appBundlePath: desktop.appBundlePath,
        agents: [],
      };
      target.agents.push({
        model: model.model,
        codexHome: resolveCodexAppServerLocalHomeDir(start, agentDir, env),
        startArgs: start.args,
        selectedAppServerCommand: selected.command,
        computerUse,
        requiresComputerUse:
          computerUse.enabled ||
          codexConfigEnablesNativeComputerUse({
            agentDir,
            homeScope: start.homeScope,
            codexHome: start.codexHome,
            env,
            pluginNames: start.managedComputerUsePluginNames ?? [computerUse.pluginName],
          }),
      });
      targets.set(desktop.appBundlePath, target);
    }
    return [...targets.values()];
  }

  return [
    {
      id: CHECK_ID,
      source: "codex",
      kind: "plugin",
      description: "Update and verify the desktop Codex runtime selected for conversations.",
      async detect(ctx, scope) {
        const targets = await selectTargets(ctx);
        const findings: HealthFinding[] = [];
        for (const target of targets) {
          if (!scope || !completed.has(target.appBundlePath)) {
            findings.push(
              finding(target, "The selected desktop Codex runtime needs an update check."),
            );
            continue;
          }
          // Resolve again after publication. A staged probe alone cannot prove final selection.
          try {
            await probe({ ...target, signal: operation.signal, assertCurrent });
          } catch (error) {
            if (commandProcessCleanup.isUncertain(error)) {
              throw error;
            }
            assertCurrent();
            findings.push(
              finding(target, `Selected Codex validation failed: ${coerceErrorMessage(error)}`),
            );
          }
        }
        return findings;
      },
      async repair(ctx, findings) {
        assertCurrent();
        if (ctx.dryRun) {
          return {
            status: "skipped",
            reason: "Dry run; no desktop download or replacement.",
            changes: [],
          };
        }
        const selectedPaths = new Set(findings.map((item) => item.path));
        const targets = (await selectTargets(ctx)).filter((target) =>
          selectedPaths.has(target.appBundlePath),
        );
        const changes: string[] = [];
        const warnings: string[] = [];
        for (const target of targets) {
          try {
            const result = await updateApp({
              appBundlePath: target.appBundlePath,
              env: ctx.env,
              signal: operation.signal,
              assertCurrent,
              validateCandidate: async ({ appBundlePath }) => {
                await probe({ ...target, appBundlePath, signal: operation.signal, assertCurrent });
              },
            });
            assertCurrent();
            completed.add(result.appBundlePath);
            changes.push(
              result.status === "updated"
                ? `Selected verified Codex desktop ${result.appBundlePath}: ${result.oldVersion} -> ${result.newVersion}. Previous runtime retained: ${result.backupPath}. Existing sessions retain their original generation.`
                : `Selected Codex desktop ${result.appBundlePath} is current (${result.newVersion}).`,
            );
            warnings.push(...(result.warnings ?? []));
          } catch (error) {
            if (commandProcessCleanup.isUncertain(error)) {
              throw error;
            }
            assertCurrent();
            warnings.push(
              `Selected Codex update failed for ${target.appBundlePath}: ${coerceErrorMessage(error)}`,
            );
          }
        }
        return {
          status: warnings.length > 0 ? "failed" : "repaired",
          changes,
          warnings,
        };
      },
    },
  ];
}
