// Google tests cover the caller reply-language preference added to the realtime system instruction.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildGoogleRealtimeSystemInstruction } from "./realtime-voice-language.js";
import { buildGoogleRealtimeVoiceProvider } from "./realtime-voice-provider.js";

const { connectMock, createGoogleGenAIMock } = vi.hoisted(() => {
  const session = {
    close: vi.fn(),
    sendClientContent: vi.fn(),
    sendRealtimeInput: vi.fn(),
    sendToolResponse: vi.fn(),
  };
  const connect = vi.fn(async (_params: { config: { systemInstruction?: string } }) => session);
  return {
    connectMock: connect,
    createGoogleGenAIMock: vi.fn(() => ({ live: { connect } })),
  };
});

vi.mock("./google-genai-runtime.js", () => ({
  createGoogleGenAI: createGoogleGenAIMock,
}));

const ENV_KEYS = ["GEMINI_API_KEY", "GOOGLE_API_KEY"] as const;
let envSnapshot: Partial<Record<(typeof ENV_KEYS)[number], string>>;

async function connectedSystemInstruction(language: string | undefined, instructions?: string) {
  const bridge = buildGoogleRealtimeVoiceProvider().createBridge({
    providerConfig: { apiKey: "gemini-key", model: "gemini-3.1-flash-live-preview" },
    instructions,
    language,
    onAudio: vi.fn(),
    onClearAudio: vi.fn(),
  });
  await bridge.connect();
  return connectMock.mock.calls.at(-1)?.[0].config.systemInstruction;
}

describe("Google realtime caller language", () => {
  beforeEach(() => {
    envSnapshot = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    for (const key of ENV_KEYS) {
      delete process.env[key];
    }
    connectMock.mockClear();
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (envSnapshot[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = envSnapshot[key];
      }
    }
  });

  it("names the language from a bare code or a BCP-47 tag", () => {
    const named = (language: string) =>
      buildGoogleRealtimeSystemInstruction(undefined, language)?.match(
        /^Reply language: (\w+) /,
      )?.[1];
    expect(named("en")).toBe("English");
    expect(named("en-us")).toBe("English");
    expect(named("es-US")).toBe("Spanish");
    expect(named(" de_DE ")).toBe("German");
  });

  it("ignores missing, malformed and unknown language hints", () => {
    for (const language of [undefined, "", "english", "qq"]) {
      expect(buildGoogleRealtimeSystemInstruction("Speak briefly.", language)).toBe(
        "Speak briefly.",
      );
    }
    expect(buildGoogleRealtimeSystemInstruction(undefined, undefined)).toBeUndefined();
  });

  it("states the preference and the caller's way out", () => {
    expect(buildGoogleRealtimeSystemInstruction(undefined, "fr")).toBe(
      "Reply language: French (the caller's device language). Respond in French even when an " +
        "utterance is transcribed as another language, because short or noisy audio is often " +
        "transcribed in the wrong language. If the caller asks you to speak a different language, " +
        "switch to it.",
    );
  });

  it("puts operator instructions after the preference so an operator reply language wins", () => {
    const instruction = buildGoogleRealtimeSystemInstruction("\nAlways reply in French.\n", "en");
    expect(instruction).toMatch(/^Reply language: English \(the caller's device language\)\./);
    expect(instruction).toMatch(/switch to it\.\n\nAlways reply in French\.$/);
  });

  it("sends the preference in the Live connect config when the session has a language", async () => {
    expect(await connectedSystemInstruction("en", "Speak briefly.")).toMatch(
      /^Reply language: English \(the caller's device language\)\..*\n\nSpeak briefly\.$/s,
    );
  });

  it("leaves the connect config unchanged without a language", async () => {
    expect(await connectedSystemInstruction(undefined, "Speak briefly.")).toBe("Speak briefly.");
  });
});
