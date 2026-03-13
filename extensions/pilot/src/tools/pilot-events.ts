import type { OpenClawPluginApi } from "openclaw/plugin-sdk/pilot";
import { resolvePilotAccount } from "../accounts.js";
import { normalizePilotTarget } from "../normalize.js";
import * as pilotctl from "../pilotctl.js";
import type { CoreConfig } from "../types.js";

export function registerPilotEventTools(api: OpenClawPluginApi) {
  api.registerTool({
    name: "pilot_publish",
    label: "Pilot Publish",
    description:
      "Publish a message to a topic on the Pilot Protocol Event Stream (port 1002). " +
      "Broadcasts data to all subscribers of the topic on the target peer.",
    parameters: {
      type: "object",
      properties: {
        target: {
          type: "string",
          description: "Pilot address or hostname of the event stream host",
        },
        topic: {
          type: "string",
          description: "Topic name to publish to",
        },
        data: {
          type: "string",
          description: "Data payload to publish",
        },
      },
      required: ["target", "topic", "data"],
    },
    async execute(_id: string, params: { target: string; topic: string; data: string }) {
      try {
        const cfg = api.runtime.config.loadConfig() as CoreConfig;
        const account = resolvePilotAccount({ cfg });
        const target = normalizePilotTarget(params.target);
        if (!target) throw new Error(`Invalid Pilot target: ${params.target}`);
        const result = await pilotctl.publish(target, params.topic, params.data, {
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

  api.registerTool({
    name: "pilot_subscribe",
    label: "Pilot Subscribe",
    description:
      "Subscribe to a topic on the Pilot Protocol Event Stream (port 1002). " +
      "Receives broadcasts from the topic on the target peer.",
    parameters: {
      type: "object",
      properties: {
        target: {
          type: "string",
          description: "Pilot address or hostname of the event stream host",
        },
        topic: {
          type: "string",
          description: "Topic name to subscribe to",
        },
      },
      required: ["target", "topic"],
    },
    async execute(_id: string, params: { target: string; topic: string }) {
      try {
        const cfg = api.runtime.config.loadConfig() as CoreConfig;
        const account = resolvePilotAccount({ cfg });
        const target = normalizePilotTarget(params.target);
        if (!target) throw new Error(`Invalid Pilot target: ${params.target}`);
        const result = await pilotctl.subscribe(target, params.topic, {
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
