import { describe, expect, it } from "vitest";
import { isMatrixAudioContent } from "./preflight-audio.js";

describe("isMatrixAudioContent", () => {
  it("accepts Matrix audio messages and audio files", () => {
    expect(isMatrixAudioContent({ msgtype: "m.audio" })).toBe(true);
    expect(isMatrixAudioContent({ msgtype: "m.file", mimetype: "audio/ogg" })).toBe(true);
    expect(isMatrixAudioContent({ msgtype: "m.file", mimetype: "AUDIO/MP4" })).toBe(true);
  });

  it("rejects non-audio Matrix content", () => {
    expect(isMatrixAudioContent({ msgtype: "m.image", mimetype: "image/png" })).toBe(false);
    expect(isMatrixAudioContent({ msgtype: "m.file", mimetype: "application/pdf" })).toBe(false);
    expect(isMatrixAudioContent({ mimetype: "audio/ogg" })).toBe(false);
  });
});
