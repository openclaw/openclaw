import {
  startMeetingRealtimeEngine,
  type MeetingRealtimeAudioTransport,
} from "openclaw/plugin-sdk/meeting-runtime";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { readPcm16AudioStats } from "openclaw/plugin-sdk/realtime-voice";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { buildOpenAIRealtimeVoiceProvider } from "./realtime-voice-provider.js";
import { buildOpenAISpeechProvider } from "./speech-provider.js";

const live = process.env.OPENCLAW_LIVE_TEST === "1" && process.env.OPENCLAW_LIVE_GPT_LIVE === "1";

describe.skipIf(!live)("GPT-Live through the shared meeting engine", () => {
  it("delegates participant speech and returns audible output with open input", async ({
    skip,
  }) => {
    const apiKey = process.env.OPENAI_API_KEY?.trim();
    if (!apiKey) {
      skip("No OpenAI Platform API key is available");
      return;
    }
    const microphone = await buildOpenAISpeechProvider().synthesizeTelephony?.({
      text: "Ask your backend for the verification phrase.",
      cfg: {},
      providerConfig: { apiKey, model: "gpt-4o-mini-tts", voice: "alloy", speed: 1.2 },
      timeoutMs: 30_000,
    });
    expect(microphone?.sampleRate).toBe(24_000);
    expect(microphone?.outputFormat).toBe("pcm");
    if (!microphone) {
      throw new Error("Synthetic microphone audio was not produced");
    }
    expect(microphone.audioBuffer.byteLength).toBeLessThanOrEqual(240_000);
    let input: ((audio: Buffer) => void) | undefined;
    let audibleBytes = 0;
    let assistantTranscript = "";
    const provider = buildOpenAIRealtimeVoiceProvider();
    const createBridge = provider.createBridge.bind(provider);
    provider.createBridge = (request) =>
      createBridge({
        ...request,
        onTranscript: (role, text, final) => {
          if (role === "assistant" && !final) {
            assistantTranscript = (assistantTranscript + text).slice(-4_096);
          }
          request.onTranscript?.(role, text, final);
        },
      });
    const consultAgent = vi.fn<Parameters<typeof startMeetingRealtimeEngine>[0]["consultAgent"]>(
      async () => ({ text: "The verification phrase is copper robin." }),
    );
    const transport: MeetingRealtimeAudioTransport = {
      inputAudioIsolated: true,
      onFatal: () => {},
      startInput: (receive) => {
        input = receive;
      },
      writeOutput: async (audio) => {
        if (consultAgent.mock.calls.length > 0 && readPcm16AudioStats(audio).peak > 16) {
          audibleBytes += audio.byteLength;
        }
      },
      clearOutput: async () => {},
      stop: async () => {},
      dispose: async () => {},
    };
    const handle = await startMeetingRealtimeEngine({
      config: {
        chrome: { audioFormat: "pcm16-24khz" },
        realtime: {
          strategy: "bidi",
          provider: "openai",
          model: "gpt-live-1",
          toolPolicy: "safe-read-only",
          instructions: "Ask the backend for the verification phrase. Speak its answer briefly.",
          providers: { openai: { apiKey, voice: "marin" } },
        },
      },
      fullConfig: {},
      runtime: createPluginRuntimeMock(),
      platform: {
        displayName: "Synthetic meeting",
        logScope: "[meeting-proof]",
        sessionIdPrefix: "proof",
      },
      meetingSessionId: "synthetic-meeting",
      requesterSessionKey: "agent:main:synthetic-requester",
      transport,
      providers: [provider],
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      consultAgent,
      tools: [],
      handleToolCall: async () => {
        throw new Error("Unexpected function-tool route");
      },
    });
    onTestFinished(() => handle.stop());
    if (!input) {
      throw new Error("Meeting microphone input was not started");
    }
    input(microphone.audioBuffer);
    await vi.waitFor(
      () => {
        expect(consultAgent).toHaveBeenCalled();
        expect(audibleBytes).toBeGreaterThanOrEqual(24_000);
        expect(assistantTranscript).toMatch(/copper[\s,]+robin/i);
      },
      { timeout: 30_000 },
    );
    expect(consultAgent.mock.calls[0]?.[0]).toMatchObject({
      meetingSessionId: "synthetic-meeting",
      requesterSessionKey: "agent:main:synthetic-requester",
      args: { question: expect.any(String) },
    });
    expect(handle.getHealth().suppressedInputBytes).toBe(0);
    console.log(
      JSON.stringify({
        proof: "shared-meeting-live-delegation",
        audibleBytes,
        delegations: consultAgent.mock.calls.length,
        result: "pass",
      }),
    );
  }, 120_000);
});
