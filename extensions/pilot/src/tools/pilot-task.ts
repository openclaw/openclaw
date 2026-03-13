import type { OpenClawPluginApi } from "openclaw/plugin-sdk/pilot";
import { resolvePilotAccount } from "../accounts.js";
import { normalizePilotTarget } from "../normalize.js";
import * as pilotctl from "../pilotctl.js";
import type { CoreConfig } from "../types.js";

export function registerPilotTaskTool(api: OpenClawPluginApi) {
  api.registerTool({
    name: "pilot_task",
    label: "Pilot Task",
    description:
      "Submit and manage tasks on the Pilot Protocol network via Task Submit (port 1003). " +
      "Actions: submit (send task to peer), list (check task statuses).",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          description: "Task action: submit, list",
        },
        target: {
          type: "string",
          description: "Pilot address or hostname for task submission (only for submit)",
        },
        task: {
          type: "string",
          description: "Task description to submit (only for submit)",
        },
      },
      required: ["action"],
    },
    async execute(_id: string, params: { action: string; target?: string; task?: string }) {
      try {
        const cfg = api.runtime.config.loadConfig() as CoreConfig;
        const account = resolvePilotAccount({ cfg });
        const opts = {
          socketPath: account.socketPath,
          pilotctlPath: account.pilotctlPath,
        };

        let result: unknown;
        switch (params.action) {
          case "submit":
            {
              if (!params.target) throw new Error("target required for submit");
              if (!params.task) throw new Error("task required for submit");
              const normalized = normalizePilotTarget(params.target);
              if (!normalized) throw new Error(`Invalid Pilot target: ${params.target}`);
              result = await pilotctl.submitTask(normalized, params.task, opts);
            }
            break;
          case "list":
            result = await pilotctl.taskList(opts);
            break;
          default:
            throw new Error(`Unknown task action: ${params.action}`);
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
