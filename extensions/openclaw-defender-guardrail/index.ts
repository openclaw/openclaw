/**
 * OpenClaw Defender Guardrail
 *
 * Runs defender check-command and check-network in the before_tool_call hook
 * for exec and web_fetch (defense in depth with core gates).
 * Requires openclaw-defender skill installed; when scripts are missing, behaves
 * according to failOpen (default: allow through).
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { resolveDefenderWorkspace, runDefenderRuntimeMonitor } from "openclaw";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";

const DEFENDER_TIMEOUT_MS = 5_000;

type DefenderGuardrailConfig = {
  failOpen?: boolean;
  guardrailPriority?: number;
};

function getExecCommandString(params: Record<string, unknown>): string | null {
  const raw = params.rawCommand;
  if (typeof raw === "string" && raw.trim()) {
    return raw.trim();
  }
  const cmd = params.command;
  if (Array.isArray(cmd) && cmd.length > 0) {
    return cmd.map((c) => String(c)).join(" ");
  }
  if (typeof cmd === "string" && cmd.trim()) {
    return cmd.trim();
  }
  return null;
}

function getWebFetchUrl(params: Record<string, unknown>): string | null {
  const url = params.url;
  if (typeof url === "string" && url.trim()) {
    return url.trim();
  }
  return null;
}

const plugin = {
  id: "openclaw-defender-guardrail",
  name: "OpenClaw Defender (guardrail)",
  description:
    "Runs defender check-command and check-network in the guardrail layer for exec and web_fetch (defense in depth; requires openclaw-defender skill installed)",
  configSchema: emptyPluginConfigSchema(),

  register(api: OpenClawPluginApi) {
    const config = (api.pluginConfig ?? {}) as DefenderGuardrailConfig;
    const failOpen = config.failOpen !== false;
    const priority = typeof config.guardrailPriority === "number" ? config.guardrailPriority : 60;

    api.on(
      "before_tool_call",
      async (event, _ctx) => {
        const { toolName, params } = event;
        const workspace = resolveDefenderWorkspace();

        if (toolName === "exec") {
          const cmd = getExecCommandString(params);
          if (!cmd) {
            return;
          }
          const result = await runDefenderRuntimeMonitor(
            workspace,
            "check-command",
            [cmd, ""],
            DEFENDER_TIMEOUT_MS,
          );
          if (result.ok) {
            return;
          }
          if (!result.ok && failOpen && (result.timedOut || !result.stderr)) {
            api.logger.warn(
              "[openclaw-defender-guardrail] check-command failed (failOpen): allow through",
            );
            return;
          }
          return {
            block: true,
            blockReason: `Command blocked by defender (guardrail). ${result.stderr ?? "Security policy denied execution."}`,
          };
        }

        if (toolName === "web_fetch") {
          const url = getWebFetchUrl(params);
          if (!url) {
            return;
          }
          const result = await runDefenderRuntimeMonitor(
            workspace,
            "check-network",
            [url, ""],
            DEFENDER_TIMEOUT_MS,
          );
          if (result.ok) {
            return;
          }
          if (!result.ok && failOpen && (result.timedOut || !result.stderr)) {
            api.logger.warn(
              "[openclaw-defender-guardrail] check-network failed (failOpen): allow through",
            );
            return;
          }
          return {
            block: true,
            blockReason: `URL blocked by defender (guardrail). ${result.stderr ?? "Security policy denied network access."}`,
          };
        }

        return;
      },
      { priority },
    );
  },
};

export default plugin;
