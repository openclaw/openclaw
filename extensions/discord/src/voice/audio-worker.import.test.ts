import { expect, it, vi } from "vitest";

vi.mock("openclaw/plugin-sdk/realtime-voice", () => {
  throw new Error("The Discord media worker must not load the voice session and agent runtime");
});

it("loads the media worker without the voice control-plane runtime", async () => {
  const { DiscordAudioWorker } = await import("./audio-worker.js");
  expect(DiscordAudioWorker).toBeTypeOf("function");
});
