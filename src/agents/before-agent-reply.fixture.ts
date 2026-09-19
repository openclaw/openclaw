import type { ReplyPayload } from "../auto-reply/reply-payload.js";

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
    name: "multiple media",
    reply: {
      text: "caption",
      mediaUrls: ["https://example.com/photo.png", "https://example.com/diagram.png"],
    },
    transcript: "caption\nphoto.png, diagram.png",
  },
] satisfies Array<{ name: string; reply: ReplyPayload; transcript: string }>;
