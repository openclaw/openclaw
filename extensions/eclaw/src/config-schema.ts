import { buildChannelConfigSchema } from "openclaw/plugin-sdk/channel-config-schema";
import { z } from "openclaw/plugin-sdk/zod";

/**
 * Config schema for the E-Claw channel.
 *
 * `apiKey` is the only required secret; the rest fall back to defaults or
 * environment variables (ECLAW_API_KEY, ECLAW_API_BASE, ECLAW_BOT_NAME,
 * ECLAW_WEBHOOK_URL).
 */
export const EclawChannelConfigSchema = buildChannelConfigSchema(
  z
    .object({
      apiKey: z.string().optional(),
      apiBase: z.string().optional(),
      botName: z.string().optional(),
      webhookUrl: z.string().optional(),
    })
    .passthrough(),
);
