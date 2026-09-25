import { expect, it, vi } from "vitest";

vi.mock("openclaw/plugin-sdk/realtime-voice", () => {
  throw new Error("The Discord media worker must not load the voice session and agent runtime");
});
vi.mock("openclaw/plugin-sdk/media-runtime", () => {
  throw new Error("The Discord media worker must not load the broad media runtime");
});
vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => {
  throw new Error("The Discord media worker must not load network policy for error formatting");
});

it("loads the media worker without the voice control-plane runtime", async () => {
  const { DiscordAudioWorker } = await import("./audio-worker.js");
  expect(DiscordAudioWorker).toBeTypeOf("function");
});
