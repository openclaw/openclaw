import type { OpenClawPluginApi } from "openclaw/plugin-sdk/pilot";
import { resolvePilotAccount } from "../accounts.js";
import * as pilotctl from "../pilotctl.js";
import type { CoreConfig } from "../types.js";

export function registerPilotDiscoverTool(api: OpenClawPluginApi) {
  api.registerTool({
    name: "pilot_discover",
    label: "Pilot Discover",
    description:
      "Discover peers on the Pilot Protocol network. " +
      "Actions: lookup (find by hostname), peers (list known peers), info (daemon status).",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          description: "Discovery action: lookup, peers, info",
        },
        hostname: {
          type: "string",
          description: "Hostname to look up (only for lookup action)",
        },
      },
      required: ["action"],
    },
    async execute(_id: string, params: { action: string; hostname?: string }) {
      try {
        const cfg = api.runtime.config.loadConfig() as CoreConfig;
        const account = resolvePilotAccount({ cfg });
        const opts = {
          socketPath: account.socketPath,
          pilotctlPath: account.pilotctlPath,
        };

        let result: unknown;
        switch (params.action) {
          case "lookup":
            if (!params.hostname) throw new Error("hostname required for lookup");
            result = await pilotctl.lookup(params.hostname, opts);
            break;
          case "peers":
            result = await pilotctl.listPeers(opts);
            break;
          case "info":
            result = await pilotctl.daemonInfo(opts);
            break;
          default:
            throw new Error(`Unknown discover action: ${params.action}`);
        }

        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
          details: undefined,
        };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text" as const, text: `Error: ${message}` }],
          details: { error: true },
        };
      }
    },
  });
}
