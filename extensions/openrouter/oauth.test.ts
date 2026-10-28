import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { ProviderAuthContext } from "openclaw/plugin-sdk/plugin-entry";
import * as providerAuth from "openclaw/plugin-sdk/provider-auth";
import * as oauth from "openclaw/plugin-sdk/provider-auth-runtime";
import * as ssrf from "openclaw/plugin-sdk/ssrf-runtime";
import { oversizedJsonResponse } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createOpenRouterOAuthAuthMethod } from "./oauth.js";

const REDIRECT = "http://localhost:3000/openrouter-oauth/callback";
const AUTH = "https://openrouter.ai/auth";
const DENIED = "OpenRouter OAuth error: access_denied: Denied";
const realPkce = providerAuth.generatePkceVerifierChallenge;
const fetchImpl = vi.fn<typeof fetch>();
const start = vi.fn<typeof oauth.startProviderOAuthLoopbackCallbackServer>();
const release = vi.fn(async () => undefined);
const redirect = (query = "state=state-1&code=AUTHCODE") => `${REDIRECT}?${query}`;
const login = (ctx: ProviderAuthContext) => createOpenRouterOAuthAuthMethod().run(ctx);

beforeEach(() => {
  fetchImpl.mockReset().mockImplementation(async () => Response.json({ key: "fixture-key" }));
  start.mockReset();
  vi.spyOn(providerAuth, "generatePkceVerifierChallenge").mockReturnValue({
    verifier: "verifier-1",
    challenge: "challenge-1",
  });
  vi.spyOn(oauth, "generateOAuthState").mockReturnValue("state-1");
  vi.spyOn(oauth, "startProviderOAuthLoopbackCallbackServer").mockImplementation(start);
  vi.spyOn(ssrf, "fetchWithSsrFGuard").mockImplementation(async ({ url, init, beforeRequest }) => {
    beforeRequest?.();
    return { response: await fetchImpl(url, init), finalUrl: url, release };
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  release.mockClear();
});

function context(isRemote = true, input = redirect()) {
  const progress = { update: vi.fn(), stop: vi.fn() };
  const text = vi.fn<ProviderAuthContext["prompter"]["text"]>(async () => input);
  const note = vi.fn(async () => undefined);
  const log = vi.fn<(message: string) => void>();
  const openUrl = vi.fn(async (_url: string) => undefined);
  const ctx = {
    config: {},
    isRemote,
    openUrl,
    prompter: { text, note, progress: () => progress },
    runtime: { log, error: vi.fn(), exit: vi.fn() },
    oauth: { createVpsAwareHandlers: vi.fn() },
  } as unknown as ProviderAuthContext;
  return { ctx, progress, text, note, log, openUrl };
}
type Callback = Awaited<ReturnType<typeof start>>;
function local(waitForCallback: Callback["waitForCallback"]) {
  const fixture = context(false);
  const close = vi.fn(async () => undefined);
  start.mockImplementation(async () => ({
    waitForCallback,
    close,
    complete: async () => undefined,
  }));
  return { ...fixture, close, run: () => login(fixture.ctx) };
}
function requestBody() {
  const body = fetchImpl.mock.calls[0]?.[1]?.body;
  assert(typeof body === "string", "Expected JSON request body");
  return JSON.parse(body) as Record<string, unknown>;
}
function authUrl(value: string, target = REDIRECT) {
  const url = new URL(value);
  const callback = new URL(url.searchParams.get("callback_url") ?? "");
  expect(url.origin + url.pathname).toBe(AUTH);
  expect(callback.origin + callback.pathname).toBe(target);
  expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  return { url, callback };
}
function exchange(response: Response) {
  fetchImpl.mockResolvedValueOnce(response);
  return login(context().ctx);
}

it("uses hosted authorization with real PKCE and no manual prompt or loopback", async () => {
  vi.mocked(providerAuth.generatePkceVerifierChallenge).mockImplementation(realPkce);
  fetchImpl.mockResolvedValueOnce(Response.json({ key: "fixture-key", user_id: "user-1" }));
  const { ctx, text, note, log, openUrl } = context();
  let challenge: string | null = null;
  ctx.oauth.authorize = async ({ state, timeoutMs, buildAuthorizationUrl }) => {
    expect(state).not.toBe("");
    expect(timeoutMs).toBe(5 * 60 * 1000);
    const { url, callback } = authUrl(
      buildAuthorizationUrl("https://gateway.example.com/auth/callback?flow=hosted-1"),
      "https://gateway.example.com/auth/callback",
    );
    expect(Object.fromEntries(callback.searchParams)).toEqual({ flow: "hosted-1", state });
    challenge = url.searchParams.get("code_challenge");
    return { code: "HOSTEDCODE", state };
  };
  expect((await login(ctx)).profiles).toMatchObject([
    {
      profileId: "openrouter:default",
      credential: {
        type: "api_key",
        provider: "openrouter",
        key: "fixture-key",
        displayName: "OpenRouter user-1",
        metadata: { authFlow: "oauth-pkce", userId: "user-1" },
      },
    },
  ]);
  for (const unused of [start, text, note, log, openUrl]) {
    expect(unused).not.toHaveBeenCalled();
  }
  expect(fetchImpl.mock.calls[0]?.[0]).toBe("https://openrouter.ai/api/v1/auth/keys");
  expect(fetchImpl.mock.calls[0]?.[1]?.method).toBe("POST");
  expect(new Headers(fetchImpl.mock.calls[0]?.[1]?.headers).get("content-type")).toBe(
    "application/json",
  );
  expect(ssrf.fetchWithSsrFGuard).toHaveBeenCalledWith(
    expect.objectContaining({ mode: "trusted_env_proxy" }),
  );
  const body = requestBody();
  expect(body).toEqual({
    code: "HOSTEDCODE",
    code_verifier: expect.any(String),
    code_challenge_method: "S256",
  });
  const verifier = body.code_verifier;
  assert(typeof verifier === "string");
  expect(verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
  expect(challenge).toBe(createHash("sha256").update(verifier).digest("base64url"));
  expect(release).toHaveBeenCalledOnce();
});

it("keeps malformed manual input correctable before exchanging a credential", async () => {
  const { ctx, text } = context();
  text.mockImplementationOnce(async ({ validate }) => {
    for (const value of [
      "chrome-error://chromewebdata/",
      "AUTHCODE",
      "code=AUTHCODE",
      "state=other&code=AUTHCODE",
    ]) {
      expect(validate?.(value)).toEqual(expect.any(String));
      expect(fetchImpl).not.toHaveBeenCalled();
    }
    expect(validate?.(redirect())).toBeUndefined();
    return redirect();
  });
  expect((await login(ctx)).profiles).toMatchObject([{ credential: { key: "fixture-key" } }]);
});

it.each([
  [redirect(), undefined],
  ["state=state-1&code=AUTHCODE", undefined],
  [redirect("state=state-1&error=access_denied&error_description=Denied"), DENIED],
  ["state=state-1&error=access_denied&error_description=Denied", DENIED],
  [redirect("error=access_denied&error_description=Denied"), "Missing OpenRouter OAuth state"],
  [
    redirect("state=wrong&error=access_denied&error_description=Denied"),
    "OpenRouter OAuth state mismatch",
  ],
  [redirect("code=AUTHCODE"), "Missing OpenRouter OAuth state"],
  [redirect("state=wrong&code=AUTHCODE"), "OpenRouter OAuth state mismatch"],
  ["AUTHCODE", "Paste the full OpenRouter redirect URL"],
])("parses the state-bound redirect %s", async (input, error) => {
  const result = login(context(true, input).ctx);
  if (error) {
    await expect(result).rejects.toThrow(error);
    expect(fetchImpl).not.toHaveBeenCalled();
  } else {
    await expect(result).resolves.toMatchObject({ defaultModel: "openrouter/auto" });
  }
});

it("bounds successful OAuth response bodies and releases transport", async () => {
  const oversized = oversizedJsonResponse({ chunkCount: 2, chunkSize: 16 * 1024 * 1024 + 10 });
  await expect(exchange(oversized.response)).rejects.toThrow(
    "JSON response exceeds 16777216 bytes",
  );
  expect(oversized.wasCanceled()).toBe(true);
  expect(release).toHaveBeenCalledOnce();
});

it.each([
  [403, "Invalid code or code_verifier", "Invalid code or code_verifier"],
  [400, { message: "Invalid code", code: 400 }, "Invalid code"],
] as const)("surfaces HTTP %s exchange errors", async (status, error, message) => {
  await expect(exchange(Response.json({ error }, { status }))).rejects.toThrow(
    `OpenRouter OAuth key exchange failed (${status}): ${message}`,
  );
});

it("bounds plain-text OAuth error bodies without response.text()", async () => {
  const response = new Response(`${"openrouter denied ".repeat(1024)}tail-marker`, { status: 502 });
  const reader = response.body!.getReader();
  const cancel = vi.spyOn(reader, "cancel");
  const releaseLock = vi.spyOn(reader, "releaseLock");
  vi.spyOn(response.body!, "getReader").mockReturnValue(reader);
  const text = vi.spyOn(response, "text");
  const error: unknown = await exchange(response).catch((caught: unknown) => caught);
  assert(error instanceof Error);
  expect(error.message).toContain("OpenRouter OAuth key exchange failed (502): openrouter denied");
  expect(error.message).not.toContain("tail-marker");
  expect(text).not.toHaveBeenCalled();
  expect(cancel).toHaveBeenCalledOnce();
  expect(releaseLock).toHaveBeenCalledOnce();
});

it("binds the local callback before opening the browser and exchanges its accepted code", async () => {
  const { run, close, openUrl, text } = local(async () => ({
    type: "authorization_code",
    code: "AUTHCODE",
    state: "state-1",
    parameters: new URLSearchParams({ code: "AUTHCODE", state: "state-1" }),
  }));
  await run();
  expect(start).toHaveBeenCalledWith(
    expect.objectContaining({ expectedState: "state-1", redirectUrl: REDIRECT }),
  );
  expect(start.mock.invocationCallOrder[0]).toBeLessThan(openUrl.mock.invocationCallOrder[0]!);
  const { url, callback } = authUrl(openUrl.mock.calls[0]![0]);
  expect(callback.searchParams.get("state")).toBe("state-1");
  expect(url.searchParams.get("code_challenge")).toBe("challenge-1");
  expect(close).toHaveBeenCalledOnce();
  expect(text).not.toHaveBeenCalled();
  expect(requestBody()).toEqual({
    code: "AUTHCODE",
    code_verifier: "verifier-1",
    code_challenge_method: "S256",
  });
});

it("closes a state-bound provider denial without exchanging a code", async () => {
  const { run, close, text } = local(async () => ({
    type: "oauth_error",
    error: "access_denied",
    errorDescription: "Denied",
  }));
  await expect(run()).rejects.toThrow(DENIED);
  expect(start).toHaveBeenCalledWith(expect.objectContaining({ expectedState: "state-1" }));
  expect(close).toHaveBeenCalledOnce();
  expect(fetchImpl).not.toHaveBeenCalled();
  expect(text).not.toHaveBeenCalled();
});

it.each(["progress", "log"] as const)(
  "closes the callback when %s reporting throws",
  async (reporter) => {
    const wait = vi.fn();
    const { progress, log, close, run } = local(wait);
    const fail = () => {
      throw new Error("reporter failed");
    };
    if (reporter === "progress") {
      progress.update.mockImplementation(fail);
    } else {
      log.mockImplementation(fail);
    }
    await expect(run()).rejects.toThrow("reporter failed");
    expect(wait).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  },
);

it("falls back to a pasted redirect when the local listener cannot start", async () => {
  start.mockRejectedValue(new Error("listen EADDRINUSE"));
  const { ctx, openUrl, text } = context(false);
  await expect(login(ctx)).resolves.toMatchObject({ defaultModel: "openrouter/auto" });
  expect(openUrl).toHaveBeenCalledOnce();
  expect(text).toHaveBeenCalledWith(
    expect.objectContaining({ message: "Paste the OpenRouter redirect URL" }),
  );
});

it("closes a failed callback before falling back to a pasted redirect", async () => {
  const { run, text, close } = local(async () => {
    throw new Error("OAuth callback timeout");
  });
  text.mockImplementationOnce(async () => {
    expect(close).toHaveBeenCalledOnce();
    return redirect();
  });
  await expect(run()).resolves.toMatchObject({
    profiles: [{ credential: { key: "fixture-key" } }],
  });
  expect(close).toHaveBeenCalledOnce();
});
