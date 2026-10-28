import { expect, it, vi } from "vitest";
import { DiscordAudioWorker } from "./audio-worker.js";

vi.mock("openclaw/plugin-sdk/realtime-voice", () => {
  throw new Error("The Discord media worker must not load the voice session and agent runtime");
});
vi.mock("openclaw/plugin-sdk/media-runtime", () => {
  throw new Error("The Discord media worker must not load the broad media runtime");
});
vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => {
  throw new Error("The Discord media worker must not load network policy for error formatting");
});

it("loads the media worker without the voice control-plane runtime", () => {
  expect(DiscordAudioWorker).toBeTypeOf("function");
});
