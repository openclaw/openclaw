import { buildChannelConfigSchema } from "openclaw/plugin-sdk/channel-config-schema";
import { z } from "zod";

export const SynologyChatChannelConfigSchema = buildChannelConfigSchema(z.object({}).passthrough());
