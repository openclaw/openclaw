import { isDeepStrictEqual } from "node:util";

const CANONICAL_SEEDED_ATTACHMENT = {
  type: "openclaw_media",
  media: {
    url: "media://inbound/seeded-image.png",
    contentType: "image/png",
    kind: "image",
    fileName: "seeded-image.png",
    sizeBytes: 3,
    transcribed: false,
  },
};

export function hasExpectedSeededMcpAttachment(attachment) {
  return isDeepStrictEqual(attachment, CANONICAL_SEEDED_ATTACHMENT);
}
