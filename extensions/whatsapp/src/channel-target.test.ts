import { describe, expect, it } from "vitest";
import { whatsappPlugin } from "./channel.js";

describe("whatsapp explicit target parsing", () => {
  it.each(["277038292303944:4@lid", "789@hosted.lid", "1555000:2@hosted"])(
    "preserves formed direct %s JIDs for downstream delivery",
    (raw) => {
      expect(whatsappPlugin.messaging?.parseExplicitTarget?.({ raw })).toEqual({
        to: raw,
        chatType: "direct",
      });
    },
  );

  it.each(["277038292303944:4@lid", "789@hosted.lid", "1555000:2@hosted"])(
    "recognizes formed direct %s JIDs as message-action targets",
    (raw) => {
      expect(whatsappPlugin.messaging?.targetResolver?.looksLikeId?.(raw)).toBe(true);
    },
  );
});
