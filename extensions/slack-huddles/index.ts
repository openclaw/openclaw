import { MeetingPlatformAdapter } from "openclaw/plugin-sdk/meeting-runtime";
import { normalizeAgentId } from "openclaw/plugin-sdk/routing";
import { Type } from "typebox";
import { SLACK_HUDDLES_CLI_METADATA } from "./src/cli-output-mode.js";
import { slackHuddlesConfig } from "./src/config.js";
import { SlackHuddlesInvalidRequestError, slackHuddlesInvalidRequest } from "./src/errors.js";
import { handleSlackHuddlesNodeHostCommand } from "./src/node-host.js";
import { createSlackHuddlesNodeInvokePolicy } from "./src/node-invoke-policy.js";
import { SlackHuddlesRuntime } from "./src/runtime.js";
import { SLACK_HUDDLES_PLATFORM_ADAPTER } from "./src/transports/slack-huddles-platform-adapter.js";

export default MeetingPlatformAdapter.createPluginShellEntry({
  platform: SLACK_HUDDLES_PLATFORM_ADAPTER,
  browserGuestLabel: "Slack huddle",
  configSchema: slackHuddlesConfig.configSchema,
  invalidRequest: slackHuddlesInvalidRequest,
  isInvalidRequest: (error) => error instanceof SlackHuddlesInvalidRequestError,
  toolParameters: Type.Object({
    action: Type.String({ enum: ["join", "leave", "status", "transcript", "speak"] }),
    url: Type.Optional(
      Type.String({
        description:
          "Slack huddle link (Copy huddle link), or an uppercase Slack channel id such as C0123ABCD / channel:C0123ABCD for the huddle in that channel. Workspace-qualified team:T0123ABCD:channel:C0123ABCD (also with a slack: prefix) gives a team-qualified huddle link. In Slack conversations the Conversation info chat_id carries the channel reference.",
      }),
    ),
    transport: Type.Optional(Type.String({ enum: ["chrome", "chrome-node"] })),
    mode: Type.Optional(Type.String({ enum: ["agent", "bidi", "transcribe"] })),
    sessionId: Type.Optional(Type.String({ description: "Slack huddle session ID" })),
    sinceIndex: Type.Optional(
      Type.Integer({ minimum: 0, description: "Resume transcript from this index" }),
    ),
    message: Type.Optional(Type.String({ description: "Instructions to speak" })),
  }),
  resolveGatewayTimeoutMs: slackHuddlesConfig.resolveGatewayOperationTimeoutMs,
  normalizeRequesterSessionKey: (value, trustedOwner) =>
    trustedOwner && typeof value === "string" && value.trim() ? value.trim() : undefined,
  normalizeToolAgentId: (agentId) => normalizeAgentId(agentId),
  resolveToolRuntime: async (api) => {
    if (!(await api.runtime.gateway.isAvailable())) {
      throw new Error("Slack huddle tools require a Gateway-hosted agent run.");
    }
    return api.runtime;
  },
  transcriptSource: { id: "slack-huddle", aliases: ["slack-huddles"] },
  runtime: SlackHuddlesRuntime,
  nodeHandler: handleSlackHuddlesNodeHostCommand,
  createNodePolicy: createSlackHuddlesNodeInvokePolicy,
  registerNodeWhen: (config) => config.enabled,
  cli: {
    descriptor: SLACK_HUDDLES_CLI_METADATA.descriptor,
    load: async () => (await import("./src/cli.js")).registerSlackHuddlesCli,
  },
});
