// Telegram helper module supports message tool schema behavior.
import { optionalPositiveIntegerSchema } from "openclaw/plugin-sdk/channel-actions";
import { Type } from "typebox";

/** Schema additions for sendLocation and sendVenue actions. */
export function createTelegramLocationExtraToolSchemas() {
  return {
    latitude: Type.Optional(
      Type.Number({
        description:
          "Latitude for sendLocation or sendVenue action (required for those actions). Range: -90 to 90.",
        minimum: -90,
        maximum: 90,
      }),
    ),
    longitude: Type.Optional(
      Type.Number({
        description:
          "Longitude for sendLocation or sendVenue action (required for those actions). Range: -180 to 180.",
        minimum: -180,
        maximum: 180,
      }),
    ),
    horizontalAccuracy: Type.Optional(
      Type.Number({
        description: "Radius of uncertainty for sendLocation in metres (0–1500). Optional.",
        minimum: 0,
        maximum: 1500,
      }),
    ),
    title: Type.Optional(
      Type.String({
        description: "Venue name shown as the title. Required for sendVenue action.",
      }),
    ),
    address: Type.Optional(
      Type.String({
        description: "Venue street address shown below the title. Required for sendVenue action.",
      }),
    ),
    foursquareId: Type.Optional(
      Type.String({ description: "Foursquare venue ID for sendVenue (optional)." }),
    ),
    googlePlaceId: Type.Optional(
      Type.String({ description: "Google Places ID for sendVenue (optional)." }),
    ),
  };
}

export function createTelegramPollExtraToolSchemas() {
  return {
    pollDurationSeconds: optionalPositiveIntegerSchema(),
    pollAnonymous: Type.Optional(Type.Boolean()),
    pollPublic: Type.Optional(Type.Boolean()),
  };
}

/** Schema additions for media-type flags on sendMessage. */
export function createTelegramMediaExtraToolSchemas() {
  return {
    asVoice: Type.Optional(
      Type.Boolean({
        description:
          "Send an audio file as a Telegram voice message (rendered with waveform). " +
          "Provide an OGG/Opus or MP3 file via mediaUrl.",
      }),
    ),
  };
}

/**
 * Schema additions for inline button descriptions.
 * Only included when inlineButtons capability is enabled.
 *
 * Pass a `presentation` object with this shape:
 * {
 *   "blocks": [
 *     {
 *       "type": "buttons",
 *       "buttons": [
 *         { "label": "Open link", "url": "https://example.com" },
 *         { "label": "Run command", "action": { "type": "command", "command": "/status" } },
 *         { "label": "Open app", "webApp": { "url": "https://myapp.tg/app" } }
 *       ]
 *     }
 *   ]
 * }
 *
 * Each button can have ONE of: url, action.type="command", or webApp.url.
 * Max 3 buttons per row; rows wrap automatically.
 */
export function createTelegramButtonsExtraToolSchemas() {
  return {
    presentation: Type.Optional(
      Type.Object(
        {
          blocks: Type.Array(
            Type.Object(
              {
                type: Type.Literal("buttons"),
                buttons: Type.Array(
                  Type.Object(
                    {
                      label: Type.String({ description: "Button label text shown to the user." }),
                      url: Type.Optional(
                        Type.String({
                          description: "URL opened in browser when button is tapped.",
                        }),
                      ),
                      action: Type.Optional(
                        Type.Object({
                          type: Type.Literal("command"),
                          command: Type.String({
                            description:
                              "OpenClaw command triggered when button is tapped, e.g. /status.",
                          }),
                        }),
                      ),
                      webApp: Type.Optional(
                        Type.Object({
                          url: Type.String({ description: "Telegram Web App URL." }),
                        }),
                      ),
                    },
                    { description: "One button. Provide exactly one of: url, action, or webApp." },
                  ),
                  { description: "Up to 3 buttons per row; rows wrap automatically." },
                ),
              },
              { description: "A row of inline keyboard buttons." },
            ),
          ),
        },
        {
          description:
            "Telegram inline keyboard attached to the message. Use for URL links, commands, or Web Apps.",
        },
      ),
    ),
  };
}
