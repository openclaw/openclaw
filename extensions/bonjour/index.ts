import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import {
  registerUncaughtExceptionHandler,
  registerUnhandledRejectionHandler,
} from "openclaw/plugin-sdk/runtime";
import { startGatewayBonjourAdvertiser } from "./src/advertiser.js";

type BonjourPluginConfig = {
  instanceName?: string;
};

function formatBonjourInstanceName(displayName: string) {
  const trimmed = displayName.trim();
  if (!trimmed) {
    return "OpenClaw";
  }
  if (/openclaw/i.test(trimmed)) {
    return trimmed;
  }
  return `${trimmed} (OpenClaw)`;
}

function resolveInstanceName(
  pluginConfig: Record<string, unknown> | undefined,
  machineDisplayName: string,
): string {
  const cfg = (pluginConfig ?? {}) as BonjourPluginConfig;
  const configured = typeof cfg.instanceName === "string" ? cfg.instanceName.trim() : "";
  return formatBonjourInstanceName(configured || machineDisplayName);
}

export default definePluginEntry({
  id: "bonjour",
  name: "Bonjour Gateway Discovery",
  description: "Advertise the local OpenClaw gateway over Bonjour/mDNS.",
  register(api) {
    api.registerGatewayDiscoveryService({
      id: "bonjour",
      advertise: async (ctx) => {
        const advertiser = await startGatewayBonjourAdvertiser(
          {
            instanceName: resolveInstanceName(api.pluginConfig, ctx.machineDisplayName),
            gatewayPort: ctx.gatewayPort,
            gatewayTlsEnabled: ctx.gatewayTlsEnabled,
            gatewayTlsFingerprintSha256: ctx.gatewayTlsFingerprintSha256,
            canvasPort: ctx.canvasPort,
            sshPort: ctx.sshPort,
            tailnetDns: ctx.tailnetDns,
            cliPath: ctx.cliPath,
            minimal: ctx.minimal,
          },
          {
            logger: api.logger,
            registerUncaughtExceptionHandler,
            registerUnhandledRejectionHandler,
          },
        );
        return { stop: advertiser.stop };
      },
    });
  },
});
