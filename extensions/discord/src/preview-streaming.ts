import { resolveChannelPreviewStreamMode } from "openclaw/plugin-sdk/channel-streaming";

export type DiscordPreviewStreamMode = "off" | "partial" | "block";

export function resolveDiscordPreviewStreamMode(
  params: {
    streamMode?: unknown;
    streaming?: unknown;
  } = {},
): DiscordPreviewStreamMode {
  return resolveChannelPreviewStreamMode(params, "off");
}
