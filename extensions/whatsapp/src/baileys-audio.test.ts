import { prepareWAMessageMedia } from "baileys/lib/Utils/messages.js";
import { expect, it } from "vitest";

it("preserves the decoded waveform when preparing a WhatsApp voice note", async () => {
  // Mono 8 kHz PCM with 64 equal blocks whose amplitudes increase from 400 to 25600.
  const header = Buffer.from(
    "UklGRiQgAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAgAAA=",
    "base64",
  );
  const samples = Buffer.alloc(8192);
  for (let sample = 0; sample < 4096; sample += 1) {
    samples.writeInt16LE((Math.floor(sample / 64) + 1) * 400, sample * 2);
  }

  const message = await prepareWAMessageMedia(
    { audio: Buffer.concat([header, samples]), ptt: true, mimetype: "audio/wav" },
    {
      upload: async () => ({
        mediaUrl: "https://example.invalid/synthetic-voice",
        directPath: "/synthetic-voice",
      }),
    },
  );

  expect(message.audioMessage?.ptt).toBe(true);
  expect(message.audioMessage?.waveform).toEqual(
    Uint8Array.from({ length: 64 }, (_, index) => Math.floor((100 * (index + 1)) / 64)),
  );
});
