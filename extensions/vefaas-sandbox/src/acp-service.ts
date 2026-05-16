import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentRegistry, createFileSessionStore, AcpxRuntime } from "acpx/runtime";
import {
  registerAcpRuntimeBackend,
  unregisterAcpRuntimeBackend,
} from "openclaw/plugin-sdk/acp-runtime-backend";
import type { OpenClawPluginService } from "openclaw/plugin-sdk/core";
import type { ResolvedVefaasPluginConfig } from "./config.js";

export const VEFAAS_OPENCODE_ACP_BACKEND_ID = "vefaas-opencode";

export function createVefaasOpencodeAcpService(params: {
  pluginConfig: ResolvedVefaasPluginConfig;
}): OpenClawPluginService {
  return {
    id: "vefaas-opencode-acp",
    async start(ctx) {
      if (!params.pluginConfig.opencode.acp) {
        return;
      }

      const stateDir = path.join(ctx.stateDir, "vefaas-opencode-acp");
      await fs.mkdir(stateDir, { recursive: true });
      const configPath = path.join(stateDir, "vefaas-config.json");
      await fs.writeFile(configPath, `${JSON.stringify(params.pluginConfig)}\n`, { mode: 0o600 });
      const proxyPath = path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "opencode-acp-proxy.mjs",
      );

      const runtime = new AcpxRuntime({
        cwd: ctx.workspaceDir ?? process.cwd(),
        sessionStore: createFileSessionStore({
          stateDir,
        }),
        agentRegistry: createAgentRegistry({
          overrides: {
            opencode: `${process.execPath} ${quoteShellArg(proxyPath)} --config ${quoteShellArg(configPath)}`,
          },
        }),
        probeAgent: "opencode",
        permissionMode: "approve-all",
        nonInteractivePermissions: "deny",
        timeoutMs: params.pluginConfig.timeoutMs,
      });

      registerAcpRuntimeBackend({
        id: VEFAAS_OPENCODE_ACP_BACKEND_ID,
        runtime,
      });
      ctx.logger.info("VEFaaS OpenCode ACP backend registered");
    },
    stop() {
      unregisterAcpRuntimeBackend(VEFAAS_OPENCODE_ACP_BACKEND_ID);
    },
  };
}

function quoteShellArg(value: string): string {
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, "'\\''")}'`;
}
