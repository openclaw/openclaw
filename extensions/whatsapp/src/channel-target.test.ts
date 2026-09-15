import { describe, expect, it } from "vitest";
import { whatsappPlugin } from "./channel.js";

describe("whatsapp explicit target parsing", () => {
  it.each(["277038292303944:4@lid", "789@hosted.lid", "1555000:2@hosted"])(
    "preserves formed direct %s JIDs for downstream delivery",
    async (raw) => {
      await expect(
        whatsappPlugin.messaging?.targetResolver?.resolveTarget?.({
          cfg: {},
          input: raw,
          normalized: raw,
        }),
      ).resolves.toEqual({
        to: raw,
        kind: "user",
        source: "normalized",
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
