/**
 * Config schema for the E-Claw channel.
 *
 * `apiKey` is the only required secret; the rest fall back to defaults or
 * environment variables (ECLAW_API_KEY, ECLAW_API_BASE, ECLAW_BOT_NAME,
 * ECLAW_WEBHOOK_URL).
 *
 * Doc references (OpenClaw repo):
 *   - docs/plugins/sdk-channel-plugins.md §"Config schema" —
 *     `buildChannelConfigSchema` wraps a plugin-owned shape with the
 *     common channel wrapper (enabled, accounts, etc.).
 *   - docs/plugins/architecture.md §"Plugin SDK import paths" —
 *     use `openclaw/plugin-sdk/channel-config-schema` and
 *     `openclaw/plugin-sdk/zod` instead of importing zod directly, so
 *     the bundled plugin ships against the same zod instance core uses.
 */
import { buildChannelConfigSchema } from "openclaw/plugin-sdk/channel-config-schema";
import { z } from "openclaw/plugin-sdk/zod";
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
