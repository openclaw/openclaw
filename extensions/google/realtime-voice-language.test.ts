import { expect, it, vi } from "vitest";
import { buildGoogleRealtimeVoiceProvider } from "./realtime-voice-provider.js";

const { connect } = vi.hoisted(() => ({
  connect: vi.fn(async (_request: { config: { systemInstruction?: string } }) => ({
    close: vi.fn(),
  })),
}));
vi.mock("./google-genai-runtime.js", () => ({
  createGoogleGenAI: () => ({ live: { connect } }),
}));

async function systemInstruction(language: string | undefined) {
  const bridge = buildGoogleRealtimeVoiceProvider().createBridge({
    providerConfig: { apiKey: "language-fixture-key" },
    language,
    instructions: "Always reply in French.",
    onAudio: vi.fn(),
    onClearAudio: vi.fn(),
  });
  await bridge.connect();
  await bridge.close();
  return connect.mock.calls.at(-1)?.[0].config.systemInstruction;
}

it.each([
  ["en-US", "English"],
  ["es", "Spanish"],
])("keeps the %s session language when short audio is mistranscribed", async (language, name) => {
  const instruction = await systemInstruction(language);
  expect(instruction).toEqual(expect.stringContaining(`Reply language: ${name}.`));
  expect(instruction).toEqual(expect.stringContaining("short or noisy"));
  expect(instruction).toEqual(expect.stringContaining("asks you to speak a different language"));
  expect(instruction).toEqual(expect.stringMatching(/\n\nAlways reply in French\.$/));
});

it.each([undefined, "", "qq", "english", "und", "mul", "zxx"])(
  "preserves operator instructions for an absent or unknown language (%s)",
  async (language) => {
    expect(await systemInstruction(language)).toBe("Always reply in French.");
  },
);
