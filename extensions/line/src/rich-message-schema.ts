import { Type, type Static } from "typebox";

const nonempty = () => Type.String({ minLength: 1 });
const closed = <T extends Parameters<typeof Type.Object>[0]>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });

const lineCardSchema = Type.Union([
  closed({
    type: Type.Literal("media_player"),
    title: nonempty(),
    artist: Type.Optional(nonempty()),
    source: Type.Optional(nonempty()),
    imageUrl: Type.Optional(Type.String({ pattern: "^https://" })),
    status: Type.Optional(Type.Union([Type.Literal("playing"), Type.Literal("paused")])),
  }),
  closed({
    type: Type.Literal("event"),
    title: nonempty(),
    date: nonempty(),
    time: Type.Optional(nonempty()),
    location: Type.Optional(nonempty()),
    description: Type.Optional(nonempty()),
  }),
  closed({
    type: Type.Literal("agenda"),
    title: nonempty(),
    events: Type.Array(
      closed({
        title: nonempty(),
        time: Type.Optional(nonempty()),
        location: Type.Optional(nonempty()),
      }),
      { minItems: 1, maxItems: 6 },
    ),
  }),
  closed({
    type: Type.Literal("device"),
    name: nonempty(),
    deviceType: Type.Optional(nonempty()),
    status: Type.Optional(nonempty()),
    controls: Type.Optional(
      Type.Array(closed({ label: nonempty(), action: nonempty() }), { maxItems: 6 }),
    ),
  }),
  closed({
    type: Type.Literal("appletv_remote"),
    name: Type.Optional(nonempty()),
    status: Type.Optional(nonempty()),
  }),
]);

export type LineRichCard = Static<typeof lineCardSchema>;

export const lineChannelDataSchema = Type.Optional(
  closed({
    line: closed({
      location: Type.Optional(
        closed({
          title: nonempty(),
          address: nonempty(),
          latitude: Type.Number({ minimum: -90, maximum: 90 }),
          longitude: Type.Number({ minimum: -180, maximum: 180 }),
        }),
      ),
      card: Type.Optional(lineCardSchema),
      mediaKind: Type.Optional(
        Type.Union([Type.Literal("image"), Type.Literal("video"), Type.Literal("audio")]),
      ),
      previewImageUrl: Type.Optional(Type.String({ pattern: "^https://" })),
      durationMs: Type.Optional(Type.Integer({ minimum: 1 })),
      trackingId: Type.Optional(nonempty()),
    }),
  }),
);
