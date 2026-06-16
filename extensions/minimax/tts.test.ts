// Minimax tests cover tts plugin behavior.
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";

const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>();
  return {
    ...actual,
    fetchWithSsrFGuard: (...args: unknown[]) => fetchWithSsrFGuardMock(...args),
  };
});

import { minimaxTTS } from "./tts.js";

describe("minimaxTTS", () => {
  function mockMinimaxResponse(payload: unknown): ReturnType<typeof vi.fn> {
    const release = vi.fn(async () => undefined);
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      release,
    });
    return release;
  }

  function baseRequest() {
    return {
      text: "hello",
      apiKey: "sk-test",
      baseUrl: "https://api.minimax.io",
      model: "speech-2.8-hd",
      voiceId: "English_expressive_narrator",
      timeoutMs: 30000,
    };
  }

  afterEach(() => {
    fetchWithSsrFGuardMock.mockReset();
    vi.restoreAllMocks();
  });

  it("caps oversized request timeout before arming abort timers", async () => {
    const timeoutSpy = vi
      .spyOn(globalThis, "setTimeout")
      .mockReturnValue(0 as unknown as ReturnType<typeof setTimeout>);
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response(
        JSON.stringify({ data: { audio: Buffer.from("audio").toString("hex") } }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
      release: vi.fn(async () => undefined),
    });

    const audio = await minimaxTTS({
      text: "hello",
      apiKey: "sk-test",
      baseUrl: "https://api.minimax.io",
      model: "speech-2.8-hd",
      voiceId: "English_expressive_narrator",
      timeoutMs: Number.MAX_SAFE_INTEGER,
    });

    expect(audio.toString()).toBe("audio");
    expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
    expect(fetchWithSsrFGuardMock.mock.calls[0]?.[0]).toMatchObject({
      timeoutMs: MAX_TIMER_TIMEOUT_MS,
    });
    expect(fetchWithSsrFGuardMock.mock.calls[0]?.[0]?.init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("throws envelope errors before decoding placeholder audio", async () => {
    const release = mockMinimaxResponse({
      base_resp: { status_code: 1002, status_msg: "Quota exceeded" },
      data: { audio: Buffer.from("placeholder").toString("hex") },
    });

    await expect(minimaxTTS(baseRequest())).rejects.toThrow(
      "MiniMax TTS API error (1002): Quota exceeded",
    );
    expect(release).toHaveBeenCalledOnce();
  });

  it("prefers envelope errors over missing audio errors", async () => {
    mockMinimaxResponse({
      base_resp: { status_code: 1039 },
      data: {},
    });

    await expect(minimaxTTS(baseRequest())).rejects.toThrow(
      "MiniMax TTS API error (1039): unknown error",
    );
  });

  it("decodes audio when the MiniMax envelope is successful", async () => {
    mockMinimaxResponse({
      base_resp: { status_code: 0 },
      data: { audio: Buffer.from("audio").toString("hex") },
    });

    const audio = await minimaxTTS(baseRequest());

    expect(audio.toString()).toBe("audio");
  });
});
