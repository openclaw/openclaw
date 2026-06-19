// Openai tests cover openai chatgpt oauth plugin behavior.
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import type { ProviderAuthContext } from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OAuthCredentials } from "./openai-chatgpt-oauth-types.runtime.js";

type LoginOpenAICodex = typeof import("./openai-chatgpt-oauth-flow.runtime.js").loginOpenAICodex;

const mocks = vi.hoisted(() => ({
  loginOpenAICodex: vi.fn<LoginOpenAICodex>(),
}));

vi.mock("./openai-chatgpt-oauth-flow.runtime.js", () => ({
  loginOpenAICodex: mocks.loginOpenAICodex,
}));

import { loginOpenAICodexOAuth, testing } from "./openai-chatgpt-oauth.runtime.js";

function createCredential(): OAuthCredentials {
  return {
    access: "access-token",
    refresh: "refresh-token",
    expires: 1_700_000_000_000,
    accountId: "acct_123",
  };
}

function createPrompter(): ProviderAuthContext["prompter"] {
  return {
    intro: vi.fn(async () => undefined),
    outro: vi.fn(async () => undefined),
    note: vi.fn(async () => undefined),
    select: vi.fn(async (params) => params.options[0]?.value),
    multiselect: vi.fn(async () => []),
    text: vi.fn(async () => "manual-code"),
    confirm: vi.fn(async () => false),
    progress: vi.fn(() => ({
      update: vi.fn(),
      stop: vi.fn(),
    })),
  };
}

describe("OpenAI Codex OAuth runtime", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
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

  it("aborts the manual prompt when browser OAuth finishes after fallback starts", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 302 })),
    );
    let manualPromptSignal: AbortSignal | undefined;
    let manualPromptSettled = false;
    const onPrompt = vi.fn((prompt: { message: string; signal?: AbortSignal }) => {
      manualPromptSignal = prompt.signal;
      return new Promise<string>((_resolve, reject) => {
        prompt.signal?.addEventListener(
          "abort",
          () => {
            reject(new Error("manual prompt aborted"));
          },
          { once: true },
        );
      });
    });
    const oauth = {
      createVpsAwareHandlers: vi.fn(() => ({
        onAuth: vi.fn(async () => undefined),
        onPrompt,
      })),
    } satisfies ProviderAuthContext["oauth"];

    mocks.loginOpenAICodex.mockImplementationOnce(async (options) => {
      options.onAuth({ url: "https://auth.openai.com/oauth/authorize" });
      void options
        .onManualCodeInput?.()
        .catch(() => undefined)
        .finally(() => {
          manualPromptSettled = true;
        });
      await vi.advanceTimersByTimeAsync(16_000);
      expect(onPrompt).toHaveBeenCalledOnce();
      return createCredential();
    });

    await expect(
      loginOpenAICodexOAuth({
        prompter: createPrompter(),
        runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
        oauth,
        isRemote: false,
        openUrl: vi.fn(async () => undefined),
      }),
    ).resolves.toEqual(createCredential());
    await Promise.resolve();
    await Promise.resolve();

    expect(manualPromptSignal?.aborted).toBe(true);
    expect(manualPromptSettled).toBe(true);
  });
});
