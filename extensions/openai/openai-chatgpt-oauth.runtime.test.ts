// Openai tests cover openai chatgpt oauth plugin behavior.
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";

const loginOpenAICodexMock = vi.hoisted(() => vi.fn());

vi.mock("./openai-chatgpt-oauth-flow.runtime.js", () => ({
  loginOpenAICodex: loginOpenAICodexMock,
}));

import { loginOpenAICodexOAuth, testing } from "./openai-chatgpt-oauth.runtime.js";

describe("OpenAI Codex OAuth runtime", () => {
  afterEach(() => {
    loginOpenAICodexMock.mockReset();
    vi.restoreAllMocks();
  });

  it("caps oversized TLS preflight timeouts before creating an abort signal", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const fetchImpl = vi.fn(async () => new Response(null, { status: 302 }));

    await expect(
      testing.runOpenAIOAuthTlsPreflight({
        timeoutMs: Number.MAX_SAFE_INTEGER,
        fetchImpl,
      }),
    ).resolves.toEqual({ ok: true });

    expect(timeoutSpy).toHaveBeenCalledWith(MAX_TIMER_TIMEOUT_MS);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("collapses auth-presenting instructions into the redirect paste prompt", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 302 }));
    const note = vi.fn(async () => {});
    const createVpsAwareHandlers = vi.fn(() => ({
      onAuth: vi.fn(),
      onPrompt: vi.fn(async () => "http://localhost:1455/auth/callback?code=test"),
    }));
    loginOpenAICodexMock.mockResolvedValueOnce({
      access: "access-token",
      refresh: "refresh-token",
      expires: Date.now() + 60_000,
    });

    await loginOpenAICodexOAuth({
      isRemote: true,
      openUrl: vi.fn(async () => {}),
      prompter: {
        presentsAuthChallenge: true,
        note,
        progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
      } as never,
      runtime: {
        log: vi.fn(),
        error: vi.fn(),
      } as never,
      oauth: {
        createVpsAwareHandlers,
      },
    });

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(note).not.toHaveBeenCalled();
    expect(createVpsAwareHandlers).toHaveBeenCalledWith(
      expect.objectContaining({
        manualPromptMessage: [
          "After signing in, paste the authorization code or full redirect URL here.",
          "If this OpenClaw process can receive the browser callback, sign-in may finish automatically before you paste.",
        ].join("\n"),
      }),
    );
  });
});
