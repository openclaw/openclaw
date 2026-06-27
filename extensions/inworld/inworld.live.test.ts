// Inworld tests cover inworld plugin behavior.
import { AuthStorage, ModelRegistry } from "openclaw/plugin-sdk/agent-sessions";
import {
  registerProviderPlugin,
  requireRegisteredProvider,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { isLiveTestEnabled } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import plugin from "./index.js";

const INWORLD_API_KEY = process.env.INWORLD_API_KEY?.trim() ?? "";
const INWORLD_LIVE_MODEL_ID = process.env.OPENCLAW_LIVE_INWORLD_MODEL?.trim() || "auto";
const LIVE = isLiveTestEnabled() && INWORLD_API_KEY.length > 0;
const describeLive = LIVE ? describe : describe.skip;

const ModelRegistryCtor = ModelRegistry as unknown as {
  new (authStorage: AuthStorage): ModelRegistry;
};

interface ChatCompletionToolCall {
  id?: string;
  function?: { name?: string; arguments?: string };
}
interface ChatCompletionChoice {
  message?: { content?: string | null; tool_calls?: ChatCompletionToolCall[] };
  finish_reason?: string;
}
interface ChatCompletionResponse {
  choices?: ChatCompletionChoice[];
}

async function postChatCompletion(body: unknown): Promise<Response> {
  return fetch("https://api.inworld.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Basic ${INWORLD_API_KEY}`,
    },
    body: JSON.stringify(body),
  });
}

const registerInworldPlugin = () =>
  registerProviderPlugin({
    plugin,
    id: "inworld",
    name: "Inworld",
  });

describeLive("inworld plugin live", () => {
  it("lists voices through the registered speech provider", async () => {
    const { speechProviders } = await registerInworldPlugin();
    const provider = requireRegisteredProvider(speechProviders, "inworld");

    const voices = await provider.listVoices?.({
      apiKey: INWORLD_API_KEY,
    });

    expect(voices?.length).toBeGreaterThan(0);
    expect(voices?.some((voice) => voice.id === "Sarah")).toBe(true);
  }, 120_000);

  it("synthesizes MP3, native voice-note Ogg/Opus, and telephony PCM", async () => {
    const { speechProviders } = await registerInworldPlugin();
    const provider = requireRegisteredProvider(speechProviders, "inworld");
    const providerConfig = {
      apiKey: INWORLD_API_KEY,
      voiceId: "Sarah",
      modelId: "inworld-tts-1.5-max",
    };

    const audioFile = await provider.synthesize({
      text: "OpenClaw Inworld text to speech integration test OK.",
      cfg: { plugins: { enabled: true } } as never,
      providerConfig,
      target: "audio-file",
      timeoutMs: 90_000,
    });

    expect(audioFile.outputFormat).toBe("mp3");
    expect(audioFile.fileExtension).toBe(".mp3");
    expect(audioFile.voiceCompatible).toBe(false);
    expect(audioFile.audioBuffer.byteLength).toBeGreaterThan(512);
    expect(audioFile.audioBuffer.subarray(0, 4).toString("ascii")).not.toBe("RIFF");

    const voiceNote = await provider.synthesize({
      text: "OpenClaw Inworld voice note integration test OK.",
      cfg: { plugins: { enabled: true } } as never,
      providerConfig,
      target: "voice-note",
      timeoutMs: 90_000,
    });

    expect(voiceNote.outputFormat).toBe("ogg_opus");
    expect(voiceNote.fileExtension).toBe(".ogg");
    expect(voiceNote.voiceCompatible).toBe(true);
    expect(voiceNote.audioBuffer.byteLength).toBeGreaterThan(128);
    expect(voiceNote.audioBuffer.subarray(0, 4).toString("ascii")).toBe("OggS");

    const telephony = await provider.synthesizeTelephony?.({
      text: "OpenClaw Inworld telephony check OK.",
      cfg: { plugins: { enabled: true } } as never,
      providerConfig,
      timeoutMs: 90_000,
    });
    if (!telephony) {
      throw new Error("Inworld telephony synthesis did not return audio");
    }
    expect(telephony.outputFormat).toBe("pcm");
    expect(telephony.sampleRate).toBe(22_050);
    expect(telephony.audioBuffer.byteLength).toBeGreaterThan(512);
    expect(telephony.audioBuffer.subarray(0, 4).toString("ascii")).not.toBe("RIFF");
  }, 180_000);

  it("resolves an Inworld LLM model and completes a chat request", async () => {
    const { providers } = await registerInworldPlugin();
    const provider = requireRegisteredProvider(providers, "inworld");

    const resolved = provider.resolveDynamicModel?.({
      provider: "inworld",
      modelId: INWORLD_LIVE_MODEL_ID,
      modelRegistry: new ModelRegistryCtor(AuthStorage.inMemory()),
    });
    if (!resolved) {
      throw new Error(`inworld provider did not resolve ${INWORLD_LIVE_MODEL_ID}`);
    }
    expect(resolved.api).toBe("openai-completions");

    const response = await postChatCompletion({
      model: resolved.id,
      messages: [{ role: "user", content: "Reply with exactly OK." }],
      max_tokens: 16,
    });
    expect(response.ok).toBe(true);
    const body = (await response.json()) as ChatCompletionResponse;
    expect(body.choices?.[0]?.message?.content?.trim()).toMatch(/^OK[.!]?$/i);
  }, 60_000);

  it("streams chat completions as SSE deltas", async () => {
    const response = await postChatCompletion({
      model: INWORLD_LIVE_MODEL_ID,
      stream: true,
      messages: [{ role: "user", content: "Count to 3." }],
      max_tokens: 32,
    });
    expect(response.ok).toBe(true);
    const text = await response.text();
    expect(text).toMatch(/^data: \{/);
    expect(text).toContain("data: [DONE]");
  }, 60_000);

  it("returns OpenAI-shaped tool_calls when a tool is offered", async () => {
    const response = await postChatCompletion({
      model: INWORLD_LIVE_MODEL_ID,
      messages: [{ role: "user", content: "What is the weather in Paris?" }],
      tools: [
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "Get the weather for a city.",
            parameters: {
              type: "object",
              properties: { city: { type: "string" } },
              required: ["city"],
            },
          },
        },
      ],
      tool_choice: "auto",
    });
    expect(response.ok).toBe(true);
    const body = (await response.json()) as ChatCompletionResponse;
    const choice = body.choices?.[0];
    expect(choice?.finish_reason).toBe("tool_calls");
    const toolCall = choice?.message?.tool_calls?.[0];
    expect(toolCall?.function?.name).toBe("get_weather");
    expect(toolCall?.function?.arguments).toMatch(/Paris/i);
  }, 60_000);
});
