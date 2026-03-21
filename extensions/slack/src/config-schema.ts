import { buildChannelConfigSchema, SlackConfigSchema } from "openclaw/plugin-sdk/slack-core";

export const SlackChannelConfigSchema = buildChannelConfigSchema(SlackConfigSchema);
