import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createRemindersTool, remindersToolDefinition } from "./src/reminders-tool.js";

export default defineToolPlugin({
  id: "artha-reminders",
  name: "Artha Reminders",
  description: "Lets each chat user schedule reminders and tasks for themselves only.",
  configSchema: Type.Object(
    {
      defaultTimezone: Type.Optional(Type.String()),
      taskToolsAllow: Type.Optional(Type.Array(Type.String())),
      maxSchedulesPerUser: Type.Optional(Type.Integer({ minimum: 1 })),
      minRepeatMinutes: Type.Optional(Type.Integer({ minimum: 1 })),
    },
    { additionalProperties: false },
  ),
  tools: (tool) => [
    tool({
      ...remindersToolDefinition,
      factory: ({ api, config, toolContext }) =>
        createRemindersTool({
          workflow: api.session.workflow,
          sessionKey: toolContext.sessionKey,
          requesterSenderId: toolContext.requesterSenderId,
          messageChannel: toolContext.messageChannel,
          agentAccountId: toolContext.agentAccountId,
          defaultTimezone: config.defaultTimezone,
          taskToolsAllow: config.taskToolsAllow,
          maxSchedulesPerUser: config.maxSchedulesPerUser,
          minRepeatMinutes: config.minRepeatMinutes,
        }),
    }),
  ],
});
