import { beforeEach, describe, expect, it, vi } from "vitest";
import { cancelTrackedTextResponse } from "../../../../test-support/streaming-error-response.js";

const { fetchWithSsrFGuardMock } = vi.hoisted(() => ({ fetchWithSsrFGuardMock: vi.fn() }));

vi.mock("../../../api.js", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

import { guardedJsonApiRequest } from "./guarded-json-api.js";

const DEFAULT_REQUEST = {
  url: "https://api.example.com/v1/calls",
  method: "GET",
  headers: {},
  allowedHostnames: ["api.example.com"],
  auditContext: "voice-call:test",
  errorPrefix: "provider error",
} satisfies Parameters<typeof guardedJsonApiRequest>[0];

const release = vi.fn(async () => {});
function request(
  response: Response,
  overrides: Partial<Parameters<typeof guardedJsonApiRequest>[0]> = {},
) {
  fetchWithSsrFGuardMock.mockResolvedValueOnce({ response, release });
  return guardedJsonApiRequest({ ...DEFAULT_REQUEST, ...overrides });
}

async function errorMessage(result: Promise<unknown>) {
  const error: unknown = await result.catch((reason: unknown) => reason);
  if (!(error instanceof Error)) {
    throw new Error("Expected request to reject with an Error");
  }
  return error.message;
}

describe("guardedJsonApiRequest", () => {
  beforeEach(() => vi.clearAllMocks());

  it("uses the SSRF-guarded fetch and parses json responses", async () => {
    await expect(
      request(new Response('{"ok":true}'), {
        method: "POST",
        headers: { Authorization: "Bearer token" },
        body: { hello: "world" },
      }),
    ).resolves.toEqual({ ok: true });

    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith({
      url: "https://api.example.com/v1/calls",
      init: {
        method: "POST",
        headers: { Authorization: "Bearer token" },
        body: JSON.stringify({ hello: "world" }),
      },
      policy: { allowedHostnames: ["api.example.com"] },
      auditContext: "voice-call:test",
      timeoutMs: 30_000,
    });
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed UTF-8 provider JSON instead of returning corrupted identifiers", async () => {
    await expect(
      request(new Response(Buffer.from('{"call_control_id":"call-\xff"}', "latin1"))),
    ).rejects.toThrow("provider error: malformed JSON response");
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("returns undefined for empty bodies and allowed 404s", async () => {
    await expect(request(new Response(""))).resolves.toBeUndefined();

    const missing = cancelTrackedTextResponse("missing", { status: 404 });
    await expect(request(missing.response, { allowNotFound: true })).resolves.toBeUndefined();
    expect(missing.wasCanceled()).toBe(true);
    expect(release).toHaveBeenCalledTimes(2);
  });

  it("bounds provider error bodies on complete UTF-8 characters and cancels overflow", async () => {
    const tracked = cancelTrackedTextResponse(`${"x".repeat(8 * 1024 - 2)}😀tail`, {
      status: 500,
    });
    const message = await errorMessage(request(tracked.response));
    expect(message).toContain("provider error: 500 ");
    expect(message).toContain("... [truncated]");
    expect(message).not.toContain("�");
    expect(message).not.toContain("tail");
    expect(message.length).toBeLessThan(8_300);
    expect(tracked.wasCanceled()).toBe(true);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("redacts credential-bearing content from provider error bodies", async () => {
    const secretBasic = "QUMxMjM6c3VwZXItc2VjcmV0LWF1dGgtdG9rZW4";
    const secretApiKey = "sk-live-1234567890abcdef";
    const detail = `Authorization: Basic ${secretBasic} rejected; retry with api_key=${secretApiKey}`;
    const message = await errorMessage(
      request(new Response(JSON.stringify({ detail }), { status: 401 }), {
        method: "POST",
        headers: { Authorization: `Basic ${secretBasic}` },
      }),
    );
    expect(message).toContain("provider error: 401 ");
    expect(message).not.toContain(secretBasic);
    expect(message).not.toContain(secretApiKey);
    expect(message).toContain("***");
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("rejects oversized json success bodies and cancels unread overflow", async () => {
    const tracked = cancelTrackedTextResponse("x".repeat(1024 * 1024 + 1), { status: 200 });
    await expect(request(tracked.response)).rejects.toThrow(
      "provider response body too large: 1048577 bytes (limit: 1048576 bytes)",
    );
    expect(tracked.wasCanceled()).toBe(true);
    expect(release).toHaveBeenCalledTimes(1);
  });
});
