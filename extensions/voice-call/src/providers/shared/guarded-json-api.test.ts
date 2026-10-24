import { beforeEach, describe, expect, it, vi } from "vitest";
import { cancelTrackedTextResponse } from "../../../../test-support/streaming-error-response.js";

const { fetchWithSsrFGuardMock } = vi.hoisted(() => ({
  fetchWithSsrFGuardMock: vi.fn(),
}));

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
function respondWith(response: Response) {
  fetchWithSsrFGuardMock.mockResolvedValueOnce({ response, release });
}

describe("guardedJsonApiRequest", () => {
  beforeEach(() => vi.clearAllMocks());

  it("uses the SSRF-guarded fetch and parses json responses", async () => {
    respondWith(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await expect(
      guardedJsonApiRequest({
        ...DEFAULT_REQUEST,
        method: "POST",
        headers: { Authorization: "Bearer token" },
        body: { hello: "world" },
        errorPrefix: "request failed",
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
    respondWith(
      new Response(
        Buffer.concat([
          Buffer.from('{"call_control_id":"call-'),
          Buffer.from([0xff]),
          Buffer.from('"}'),
        ]),
        { status: 200 },
      ),
    );
    await expect(guardedJsonApiRequest(DEFAULT_REQUEST)).rejects.toThrow(
      "provider error: malformed JSON response",
    );
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("returns undefined for empty bodies and allowed 404s", async () => {
    respondWith(new Response("", { status: 200 }));
    await expect(guardedJsonApiRequest(DEFAULT_REQUEST)).resolves.toBeUndefined();

    const missing = cancelTrackedTextResponse("missing", { status: 404 });
    respondWith(missing.response);
    await expect(
      guardedJsonApiRequest({ ...DEFAULT_REQUEST, allowNotFound: true }),
    ).resolves.toBeUndefined();
    expect(missing.wasCanceled()).toBe(true);
    expect(release).toHaveBeenCalledTimes(2);
  });

  it("bounds provider error bodies on complete UTF-8 characters and cancels overflow", async () => {
    const tracked = cancelTrackedTextResponse(`${"x".repeat(8 * 1024 - 2)}😀tail`, {
      status: 500,
    });
    respondWith(tracked.response);

    let caught: Error | undefined;
    try {
      await guardedJsonApiRequest(DEFAULT_REQUEST);
    } catch (error) {
      caught = error as Error;
    }

    expect(caught?.message).toContain("provider error: 500 ");
    expect(caught?.message).toContain("... [truncated]");
    expect(caught?.message).not.toContain("�");
    expect(caught?.message).not.toContain("tail");
    expect(caught?.message.length).toBeLessThan(8_300);
    expect(tracked.wasCanceled()).toBe(true);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("redacts credential-bearing content from provider error bodies", async () => {
    const secretBasic = "QUMxMjM6c3VwZXItc2VjcmV0LWF1dGgtdG9rZW4";
    const secretApiKey = "sk-live-1234567890abcdef";
    respondWith(
      new Response(
        JSON.stringify({
          message: "Authentication failed",
          detail: `Authorization: Basic ${secretBasic} rejected; retry with api_key=${secretApiKey}`,
        }),
        { status: 401 },
      ),
    );

    let caught: Error | undefined;
    try {
      await guardedJsonApiRequest({
        ...DEFAULT_REQUEST,
        method: "POST",
        headers: { Authorization: `Basic ${secretBasic}` },
      });
    } catch (error) {
      caught = error as Error;
    }

    expect(caught?.message).toContain("provider error: 401 ");
    expect(caught?.message).not.toContain(secretBasic);
    expect(caught?.message).not.toContain(secretApiKey);
    expect(caught?.message).toContain("***");
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("rejects oversized json success bodies and cancels unread overflow", async () => {
    const tracked = cancelTrackedTextResponse("x".repeat(1024 * 1024 + 1), { status: 200 });
    respondWith(tracked.response);
    await expect(guardedJsonApiRequest(DEFAULT_REQUEST)).rejects.toThrow(
      "provider response body too large: 1048577 bytes (limit: 1048576 bytes)",
    );
    expect(tracked.wasCanceled()).toBe(true);
    expect(release).toHaveBeenCalledTimes(1);
  });
});
