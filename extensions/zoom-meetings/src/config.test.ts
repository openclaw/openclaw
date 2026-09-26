import { describe, expect, it } from "vitest";
import { zoomMeetingsConfig } from "./config.js";

const resolveZoomMeetingsConfig = zoomMeetingsConfig.resolveConfig;
describe("Zoom meetings config", () => {
  it("builds native command pairs for the selected audio backend and format", () => {
    const config = resolveZoomMeetingsConfig({
      chrome: { audioBackend: "blackhole-2ch", audioBufferBytes: 2048 },
    });
    expect(config.chrome.audioInputCommand).toContain("sox");
    expect(config.chrome.audioInputCommand).toContain("2048");
    expect(config.chrome.audioOutputCommand).toContain("BlackHole 2ch");

    const g711 = resolveZoomMeetingsConfig({
      chrome: { audioBackend: "blackhole-2ch", audioFormat: "g711-ulaw-8khz" },
    });
    expect(g711.chrome.audioInputCommand).toContain("BlackHole 2ch");
    expect(g711.chrome.audioOutputCommand).toContain("BlackHole 2ch");
    expect(g711.chrome.audioInputCommand).toContain("mu-law");

    const linux = resolveZoomMeetingsConfig({
      chrome: { audioBackend: "pipewire-pulse", audioFormat: "g711-ulaw-8khz" },
    });
    expect(linux.chrome.audioInputCommand).toContain("parec");
    expect(linux.chrome.audioInputCommand).toContain("--format=ulaw");
    expect(linux.chrome.audioOutputCommand).toContain("pacat");
  });
});
