import type { ProviderAuthContext } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi, type TestPluginApiInput } from "openclaw/plugin-sdk/plugin-test-api";
import type { OAuthCredential } from "openclaw/plugin-sdk/provider-auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "./index.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };

const NOW = 1_800_000_000_000;
const device = {
  device_code: "test-device-code",
  user_code: "TEST-CODE",
  verification_uri: "https://huggingface.co/oauth/device",
  expires_in: 60,
};
const token = {
  access_token: "test-access-token",
  refresh_token: "test-refresh-token",
  token_type: "bearer",
  expires_in: 3600,
  scope: "inference-api",
};

function registerProvider() {
  const register = vi.fn<NonNullable<TestPluginApiInput["registerProvider"]>>();
  plugin.register(createTestPluginApi({ registerProvider: register }));
  const provider = register.mock.calls[0]?.[0];
  if (!provider) {
    throw new Error("Hugging Face provider was not registered");
  }
  return provider;
}

function context(signal?: AbortSignal, isRemote = true) {
  const ctx = {
    config: {},
    isRemote,
    signal,
    assertCurrent: vi.fn(),
    openUrl: vi.fn(async () => {}),
    prompter: {
      intro: vi.fn(async () => {}),
      outro: vi.fn(async () => {}),
      note: vi.fn(async () => {}),
      text: vi.fn(async () => "test-public-client"),
      select: async () => {
        throw new Error("Unexpected select");
      },
      multiselect: async () => {
        throw new Error("Unexpected multiselect");
      },
      confirm: vi.fn(async () => true),
      progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
    },
    runtime: {
      log: vi.fn(),
      error: vi.fn(),
      exit: () => {
        throw new Error("Unexpected exit");
      },
    },
    oauth: {
      createVpsAwareHandlers: () => {
        throw new Error("Unexpected browser callback");
      },
    },
  } satisfies ProviderAuthContext;
  return ctx;
}

function login(ctx = context()) {
  const method = registerProvider().auth.find((entry) => entry.id === "oauth");
  if (!method) {
    throw new Error("Hugging Face OAuth was not registered");
  }
  return method.run(ctx);
}

function formBody(body: BodyInit | null | undefined): URLSearchParams {
  if (!(body instanceof URLSearchParams)) {
    throw new Error("Expected a URL-encoded OAuth form");
  }
  return body;
}

function respond(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("Hugging Face device login", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("resolves the onboarding choice, uses inference-only scope, respects backoff, and returns refreshable credentials", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(respond(device))
      .mockResolvedValueOnce(respond({ error: "authorization_pending" }, 400))
      .mockResolvedValueOnce(respond({ error: "slow_down" }, 400))
      .mockResolvedValueOnce(respond(token));
    const ctx = context();
    const choice = manifest.providerAuthChoices.find(
      (entry) => entry.choiceId === "huggingface-oauth",
    );
    const method = registerProvider().auth.find(
      (entry) => entry.id === choice?.method && entry.wizard?.choiceId === choice?.choiceId,
    );
    if (!method) {
      throw new Error("Hugging Face OAuth onboarding choice was not registered");
    }
    const result = method.run(ctx);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[0]).toBe("https://huggingface.co/oauth/device");
    expect(formBody(fetch.mock.calls[0]?.[1]?.body).toString()).toBe(
      "client_id=test-public-client&scope=inference-api",
    );
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetch).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(fetch).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    const auth = await result;
    expect(auth.profiles[0]).toMatchObject({
      profileId: "huggingface:default",
      credential: {
        type: "oauth",
        provider: "huggingface",
        access: token.access_token,
        refresh: token.refresh_token,
        expires: NOW + 20_000 + 3_600_000,
        clientId: "test-public-client",
        authorizationScope: "inference-api",
        grantedScope: "inference-api",
      },
    });
    expect(formBody(fetch.mock.calls[1]?.[1]?.body).get("grant_type")).toBe(
      "urn:ietf:params:oauth:grant-type:device_code",
    );
    expect(ctx.openUrl).not.toHaveBeenCalled();
    expect(ctx.prompter.note).toHaveBeenCalledWith(
      expect.stringContaining("TEST-CODE"),
      "Authorize Hugging Face",
    );
  });

  it("accepts the HF short-domain verification URL and stores access-only grants as expiring tokens", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(respond({ ...device, verification_uri: "https://hf.co/oauth/device" }))
      .mockResolvedValueOnce(respond({ ...token, refresh_token: undefined }));
    const ctx = context(undefined, false);
    const result = login(ctx);
    await vi.runAllTimersAsync();
    const auth = await result;
    expect(auth.profiles[0]).toMatchObject({
      credential: { type: "token", token: token.access_token, expires: NOW + 5_000 + 3_600_000 },
      secretStorage: { kind: "store", namePrefix: "HUGGINGFACE_OAUTH_TOKEN" },
    });
    expect(auth.notes?.join(" ")).toContain("did not issue a refresh token");
    expect(ctx.openUrl).toHaveBeenCalledWith("https://hf.co/oauth/device");
  });

  it.each(["timeout", "server", "proxy"])(
    "keeps the device code alive after a transient %s failure",
    async (failure) => {
      const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(respond(device));
      if (failure === "timeout") {
        fetch.mockRejectedValueOnce(new DOMException("Timed out", "TimeoutError"));
      } else {
        fetch.mockResolvedValueOnce(
          failure === "server" ? respond({}, 503) : new Response("proxy unavailable"),
        );
      }
      fetch.mockResolvedValueOnce(respond(token));
      const result = login();
      await vi.advanceTimersByTimeAsync(14_999);
      expect(fetch).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect((await result).profiles[0]?.credential).toMatchObject({
        type: "oauth",
        access: token.access_token,
      });
    },
  );

  it.each(["note", "browser"])(
    "cancels while the %s operation is still pending",
    async (operation) => {
      const controller = new AbortController();
      const ctx = context(controller.signal, false);
      const never = new Promise<void>(() => {});
      if (operation === "note") {
        ctx.prompter.note.mockResolvedValueOnce(undefined).mockImplementationOnce(() => never);
      } else {
        ctx.openUrl.mockImplementationOnce(() => never);
      }
      const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(respond(device));
      const result = expect(login(ctx)).rejects.toThrow(/cancelled|aborted/);
      await vi.advanceTimersByTimeAsync(0);
      controller.abort();
      await result;
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each([
    [
      { error: "access_denied", error_description: "test-secret-must-not-leak" },
      "Authorization was denied",
    ],
    [{ error: "expired_token" }, "device code expired"],
    [{ ...token, expires_in: 0 }, "valid expires_in"],
    [{ ...token, scope: "profile" }, "did not grant inference-api"],
  ])("rejects an unusable grant without returning credentials: %j", async (response, message) => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(respond(device))
      .mockResolvedValueOnce(respond(response));
    const result = expect(login()).rejects.toThrow(message);
    await vi.runAllTimersAsync();
    await result;
  });

  it("stops polling when the device code expires", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(respond({ ...device, expires_in: 6 }))
      .mockResolvedValue(respond({ error: "authorization_pending" }, 400));
    const result = expect(login()).rejects.toThrow("device code expired");
    await vi.runAllTimersAsync();
    await result;
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("cancels a pending poll and leaves no polling timer", async () => {
    const controller = new AbortController();
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(respond(device));
    const result = expect(login(context(controller.signal))).rejects.toThrow("Login cancelled");
    await vi.advanceTimersByTimeAsync(1_000);
    controller.abort();
    await result;
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rechecks caller authority after the code is displayed", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(respond(device));
    const ctx = context();
    ctx.prompter.note
      .mockImplementationOnce(async () => {})
      .mockImplementationOnce(async () => {
        ctx.assertCurrent.mockImplementation(() => {
          throw new Error("Caller revoked");
        });
      });
    await expect(login(ctx)).rejects.toThrow("Caller revoked");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(ctx.openUrl).not.toHaveBeenCalled();
  });

  it.each([undefined, "test-rotated-refresh"])(
    "refreshes with the stored client ID and preserves or rotates the refresh token: %s",
    async (refreshToken) => {
      const fetch = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(respond({ ...token, refresh_token: refreshToken }));
      const credential: OAuthCredential = {
        type: "oauth",
        provider: "huggingface",
        access: "test-old-access",
        refresh: "test-old-refresh",
        expires: NOW - 1,
        clientId: "test-public-client",
      };
      const result = await registerProvider().refreshOAuth?.(credential);
      expect(result).toMatchObject({
        access: token.access_token,
        refresh: refreshToken ?? credential.refresh,
        expires: NOW + 3_600_000,
        clientId: credential.clientId,
      });
      expect(formBody(fetch.mock.calls[0]?.[1]?.body).toString()).toBe(
        "grant_type=refresh_token&client_id=test-public-client&refresh_token=test-old-refresh",
      );
    },
  );

  it("reports revoked refresh grants without exposing reflected credentials", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      respond({ error: "invalid_grant", error_description: "test-reflected-refresh" }, 400),
    );
    const credential: OAuthCredential = {
      type: "oauth",
      provider: "huggingface",
      access: "test-old-access",
      refresh: "test-old-refresh",
      expires: NOW - 1,
      clientId: "test-public-client",
    };
    await expect(registerProvider().refreshOAuth?.(credential)).rejects.toThrow(
      "Hugging Face OAuth: The Hugging Face session expired or was revoked. Run login again.",
    );
    expect(credential.access).toBe("test-old-access");
  });
});
