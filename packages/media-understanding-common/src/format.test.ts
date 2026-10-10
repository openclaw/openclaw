import { describe, expect, it } from "vitest";
import { formatMediaUnderstandingBody } from "./format.js";
import type { MediaUnderstandingOutput } from "./types.js";

function output(
  kind: MediaUnderstandingOutput["kind"],
  text: string,
  attachmentIndex = 0,
  provider = "groq",
): MediaUnderstandingOutput {
  return { kind, text, attachmentIndex, provider };
}

describe("formatMediaUnderstandingBody", () => {
  it("includes user text when body is meaningful", () => {
    const body = formatMediaUnderstandingBody({
      body: "caption here",
      outputs: [output("audio.transcription", "transcribed")],
    });
    expect(body).toBe("[Audio]\nUser text:\ncaption here\nTranscript:\ntranscribed");
  });

  it("keeps user text once when multiple outputs exist", () => {
    const body = formatMediaUnderstandingBody({
      body: "caption here",
      outputs: [
        output("audio.transcription", "audio text"),
        output("video.description", "video text", 1, "google"),
      ],
    });
    expect(body).toBe(
      [
        "User text:\ncaption here",
        "[Audio]\nTranscript:\naudio text",
        "[Video]\nDescription:\nvideo text",
      ].join("\n\n"),
    );
  });

  it("formats image outputs", () => {
    const body = formatMediaUnderstandingBody({
      outputs: [output("image.description", "a cat", 0, "openai")],
    });
    expect(body).toBe("[Image]\nDescription:\na cat");
  });

  it("labels audio transcripts by their attachment order", () => {
    const body = formatMediaUnderstandingBody({
      outputs: [
        output("audio.transcription", "first clip was silent", 0, "openclaw"),
        output("audio.transcription", "second clip has speech", 1),
      ],
    });
    expect(body).toBe(
      [
        "[Audio 1/2]\nTranscript:\nfirst clip was silent",
        "[Audio 2/2]\nTranscript:\nsecond clip has speech",
      ].join("\n\n"),
    );
  });
});
