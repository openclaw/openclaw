// Telegram agent tools for native location, venue, and video-note delivery.
import { readNumberParam, readStringParam } from "openclaw/plugin-sdk/channel-actions";
import type { ChannelAgentTool } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { Type } from "typebox";
import { sendLocationTelegram, sendVenueTelegram, sendVideoNoteTelegram } from "./send.js";
import { resolveTelegramToken } from "./token.js";

function ok(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

function requireToken(cfg: OpenClawConfig): string {
  const { token } = resolveTelegramToken(cfg, {});
  if (!token) {
    throw new Error("Telegram bot token is not configured. Run openclaw onboard to set it up.");
  }
  return token;
}

export function createTelegramLocationTools(cfg: OpenClawConfig): ChannelAgentTool[] {
  const sendLocation: ChannelAgentTool = {
    name: "telegram_send_location",
    label: "Send Location (Telegram)",
    description:
      "Send a native Telegram location pin to a chat. Use this whenever the user asks to share a location, map point, or coordinates — instead of sending text with coordinates.",
    parameters: Type.Object({
      to: Type.String({ description: "Telegram chat ID or username to send to." }),
      latitude: Type.Number({
        description: "Latitude of the location. Range: -90 to 90.",
        minimum: -90,
        maximum: 90,
      }),
      longitude: Type.Number({
        description: "Longitude of the location. Range: -180 to 180.",
        minimum: -180,
        maximum: 180,
      }),
      horizontalAccuracy: Type.Optional(
        Type.Number({
          description: "Radius of uncertainty in metres (0–1500). Optional.",
          minimum: 0,
          maximum: 1500,
        }),
      ),
    }),
    execute: async (_toolCallId, args) => {
      const token = requireToken(cfg);
      const params = args as Record<string, unknown>;
      const to = readStringParam(params, "to", { required: true });
      const latitude = readNumberParam(params, "latitude", { required: true });
      const longitude = readNumberParam(params, "longitude", { required: true });
      const horizontalAccuracy = readNumberParam(params, "horizontalAccuracy");
      const result = await sendLocationTelegram(
        to,
        { latitude, longitude, ...(horizontalAccuracy != null ? { horizontalAccuracy } : {}) },
        { cfg, token },
      );
      return ok({ ok: true, ...result });
    },
  };

  const sendVenue: ChannelAgentTool = {
    name: "telegram_send_venue",
    label: "Send Venue (Telegram)",
    description:
      "Send a native Telegram venue card with a map pin, title, and address. Use this for named places (cafes, offices, landmarks) instead of plain text.",
    parameters: Type.Object({
      to: Type.String({ description: "Telegram chat ID or username to send to." }),
      latitude: Type.Number({ minimum: -90, maximum: 90 }),
      longitude: Type.Number({ minimum: -180, maximum: 180 }),
      title: Type.String({ description: "Venue name shown as the card title." }),
      address: Type.String({ description: "Street address shown below the title." }),
      foursquareId: Type.Optional(Type.String({ description: "Foursquare venue ID (optional)." })),
      googlePlaceId: Type.Optional(Type.String({ description: "Google Places ID (optional)." })),
    }),
    execute: async (_toolCallId, args) => {
      const token = requireToken(cfg);
      const params = args as Record<string, unknown>;
      const to = readStringParam(params, "to", { required: true });
      const latitude = readNumberParam(params, "latitude", { required: true });
      const longitude = readNumberParam(params, "longitude", { required: true });
      const title = readStringParam(params, "title", { required: true });
      const address = readStringParam(params, "address", { required: true });
      const foursquareId = readStringParam(params, "foursquareId");
      const googlePlaceId = readStringParam(params, "googlePlaceId");
      const result = await sendVenueTelegram(
        to,
        {
          latitude,
          longitude,
          title,
          address,
          ...(foursquareId ? { foursquareId } : {}),
          ...(googlePlaceId ? { googlePlaceId } : {}),
        },
        { cfg, token },
      );
      return ok({ ok: true, ...result });
    },
  };

  const sendVideoNote: ChannelAgentTool = {
    name: "telegram_send_video_note",
    label: "Send Video Note / Круглое видео (Telegram)",
    description:
      "Send a native Telegram round video note (видеокружок / circle video). Requires a square MP4 URL or path, max 60 seconds. Use this when the user asks to send a round video.",
    parameters: Type.Object({
      to: Type.String({ description: "Telegram chat ID or username to send to." }),
      mediaUrl: Type.String({
        description: "Square MP4 video URL or local file path (max 60 s, side ≤ 639 px).",
      }),
    }),
    execute: async (_toolCallId, args) => {
      const token = requireToken(cfg);
      const params = args as Record<string, unknown>;
      const to = readStringParam(params, "to", { required: true });
      const mediaUrl = readStringParam(params, "mediaUrl", { required: true });
      const result = await sendVideoNoteTelegram(to, mediaUrl, { cfg, token });
      return ok({ ok: true, ...result });
    },
  };

  return [sendLocation, sendVenue, sendVideoNote];
}
