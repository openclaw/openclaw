import type { ReplyPayload } from "../auto-reply/reply-payload.js";
import { HEARTBEAT_TOKEN, SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";

export const CLAIMED_REPLY_MEDIA_CASES = [
  { name: "text", reply: { text: "user turn claimed" }, transcript: "user turn claimed" },
  {
    name: "media only",
    reply: { mediaUrl: "https://example.com/photo.png" },
    transcript: "photo.png",
  },
  {
    name: "captioned media",
    reply: { text: "caption", mediaUrl: "https://example.com/photo.png" },
    transcript: "caption\nphoto.png",
  },
  {
    name: "silent token with media",
    reply: { text: SILENT_REPLY_TOKEN, mediaUrl: "https://example.com/photo.png" },
    transcript: "photo.png",
    expectedDeliveryText: "",
  },
  {
    name: "mixed silent token text",
    reply: { text: `Hello ${SILENT_REPLY_TOKEN}` },
    transcript: "Hello",
    expectedDeliveryText: "Hello",
  },
  {
    name: "mixed silent token with media",
    reply: { text: `Hello ${SILENT_REPLY_TOKEN}`, mediaUrl: "https://example.com/photo.png" },
    transcript: "Hello\nphoto.png",
    expectedDeliveryText: "Hello",
  },
  {
    name: "mixed heartbeat token text",
    reply: { text: `Hello ${HEARTBEAT_TOKEN}` },
    transcript: "Hello",
    expectedDeliveryText: "Hello",
  },
  {
    name: "mixed heartbeat token media",
    reply: { text: `Hello ${HEARTBEAT_TOKEN}`, mediaUrl: "https://example.com/photo.png" },
    transcript: "Hello\nphoto.png",
    expectedDeliveryText: "Hello",
  },
  {
    name: "heartbeat token media",
    reply: { text: HEARTBEAT_TOKEN, mediaUrl: "https://example.com/photo.png" },
    transcript: "photo.png",
    expectedDeliveryText: "",
  },
  {
    name: "heartbeat token location",
    reply: {
      text: HEARTBEAT_TOKEN,
      location: { latitude: 48.858844, longitude: 2.294351 },
    },
    transcript: "📍 48.858844, 2.294351",
    expectedDeliveryText: "",
  },
  {
    name: "heartbeat token with opaque channel data",
    reply: {
      text: HEARTBEAT_TOKEN,
      channelData: {
        slack: { blocks: [{ type: "section", text: { type: "plain_text", text: "Hello" } }] },
      },
    },
    transcript: null,
    expectedDeliveryText: "",
  },
  {
    name: "silent token with opaque channel data",
    reply: {
      text: SILENT_REPLY_TOKEN,
      channelData: {
        slack: { blocks: [{ type: "section", text: { type: "plain_text", text: "Hello" } }] },
      },
    },
    transcript: null,
    expectedDeliveryText: "",
  },
  {
    name: "multiple media",
    reply: {
      text: "caption",
      mediaUrls: ["https://example.com/photo.png", "https://example.com/diagram.png"],
    },
    transcript: "caption\nphoto.png, diagram.png",
  },
] satisfies Array<{
  name: string;
  reply: ReplyPayload;
  transcript: string | null;
  expectedDeliveryText?: string;
}>;
