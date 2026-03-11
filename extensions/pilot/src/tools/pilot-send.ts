import type { OpenClawPluginApi } from "openclaw/plugin-sdk/pilot";
import { resolvePilotAccount } from "../accounts.js";
import * as pilotctl from "../pilotctl.js";
import type { CoreConfig } from "../types.js";

export function registerPilotSendTool(api: OpenClawPluginApi) {
  api.registerTool({
    name: "pilot_send",
    label: "Pilot Send",
    description:
      "Send a text message to a peer on the Pilot Protocol network via Data Exchange (port 1001). " +
      "Target can be a Pilot address (N:NNNN.HHHH.LLLL) or a hostname.",
    parameters: {
      type: "object",
      properties: {
        target: {
          type: "string",
          description: "Pilot address or hostname of the recipient",
        },
        message: {
          type: "string",
          description: "The message text to send",
        },
      },
      required: ["target", "message"],
    },
    async execute(_id: string, params: { target: string; message: string }) {
      try {
        const cfg = api.runtime.config.loadConfig() as CoreConfig;
        const account = resolvePilotAccount({ cfg });
        const result = await pilotctl.sendMessage(params.target, params.message, {
          socketPath: account.socketPath,
          pilotctlPath: account.pilotctlPath,
        });
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
