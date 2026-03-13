import type { OpenClawPluginApi } from "openclaw/plugin-sdk/pilot";
import { resolvePilotAccount } from "../accounts.js";
import { normalizePilotTarget } from "../normalize.js";
import * as trust from "../trust.js";
import type { CoreConfig } from "../types.js";

export function registerPilotTrustTool(api: OpenClawPluginApi) {
  api.registerTool({
    name: "pilot_trust",
    label: "Pilot Trust",
    description:
      "Manage trust relationships on the Pilot Protocol network. " +
      "Actions: handshake (initiate), approve, reject, list (trusted peers), pending (requests).",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          description: "Trust action: handshake, approve, reject, list, pending",
        },
        target: {
          type: "string",
          description: "Pilot address for handshake/approve/reject (not needed for list/pending)",
        },
      },
      required: ["action"],
    },
    async execute(_id: string, params: { action: string; target?: string }) {
      try {
        const cfg = api.runtime.config.loadConfig() as CoreConfig;
        const account = resolvePilotAccount({ cfg });
        const opts = {
          socketPath: account.socketPath,
          pilotctlPath: account.pilotctlPath,
        };

        const resolveTarget = (raw?: string): string => {
          if (!raw) throw new Error("target required");
          const normalized = normalizePilotTarget(raw);
          if (!normalized) throw new Error(`Invalid Pilot target: ${raw}`);
          return normalized;
        };

        let result: unknown;
        switch (params.action) {
          case "handshake":
            result = await trust.handshake(resolveTarget(params.target), opts);
            break;
          case "approve":
            result = await trust.approve(resolveTarget(params.target), opts);
            break;
          case "reject":
            result = await trust.reject(resolveTarget(params.target), opts);
            break;
          case "list":
            result = await trust.listTrusted(opts);
            break;
          case "pending":
            result = await trust.listPending(opts);
            break;
          default:
            throw new Error(`Unknown trust action: ${params.action}`);
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
