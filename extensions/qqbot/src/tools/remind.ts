import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { RemindSchema, executeRemind } from "../engine/tools/remind-logic.js";
import type { RemindParams } from "../engine/tools/remind-logic.js";

export function registerRemindTool(api: OpenClawPluginApi): void {
  api.registerTool(
    {
      name: "qqbot_remind",
      label: "QQBot Reminder",
      description:
        "Create, list, and remove QQ reminders. " +
        "Use simple parameters without manually building cron JSON.\n" +
        "Create: action=add, content=message, to=target, time=schedule\n" +
        "List: action=list\n" +
        "Remove: action=remove, jobId=job id from list\n" +
        'Time examples: "5m", "1h", "0 8 * * *"',
      parameters: RemindSchema,
      async execute(_toolCallId, params) {
        return executeRemind(params as RemindParams);
      },
    },
    { name: "qqbot_remind" },
  );
}
