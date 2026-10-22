import { SsrFBlockedError } from "openclaw/plugin-sdk/ssrf-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { authenticate } from "./auth.js";

const privateLogin = () =>
  authenticate("http://127.0.0.1:8080", "code", {
    ssrfPolicy: { allowPrivateNetwork: true },
  });
function mockResponse(body: BodyInit, status = 200) {
  const response = new Response(body, {
    status,
    headers: { "set-cookie": "urbauth-~zod=123; Path=/; HttpOnly" },
  });
  const fetch = vi.fn().mockResolvedValue(response);
  vi.stubGlobal("fetch", fetch);
  return { response, fetch };
}
function openBody(bytes: Uint8Array, cancel?: () => void) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
    },
    cancel,
  });
}

describe("tlon urbit auth ssrf", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("blocks private IPs by default", async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    await expect(authenticate("http://127.0.0.1:8080", "code")).rejects.toBeInstanceOf(
      SsrFBlockedError,
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("allows private IPs when allowPrivateNetwork is enabled", async () => {
    const { response, fetch } = mockResponse("ok");
    expect(await privateLogin()).toContain("urbauth-~zod=123");
    expect(response.bodyUsed).toBe(true);
    expect(fetch).toHaveBeenCalled();
  });

  it("cancels an open body stream as soon as the drain cap is reached", async () => {
    let canceled = false;
    mockResponse(
      openBody(new Uint8Array(64 * 1024).fill(0x78), () => {
        canceled = true;
      }),
    );
    expect(await privateLogin()).toContain("urbauth-~zod=123");
    expect(canceled).toBe(true);
  });

  it("cancels failed login bodies before throwing", async () => {
    let canceled = false;
    mockResponse(
      openBody(new TextEncoder().encode("login failed"), () => {
        canceled = true;
      }),
      401,
    );
    await expect(privateLogin()).rejects.toMatchObject({
      name: "UrbitAuthError",
      message: "Login failed with status 401",
    });
    expect(canceled).toBe(true);
  });

  it("rejects failed logins promptly when a response clone keeps cancellation pending", async () => {
    const { response } = mockResponse(openBody(new TextEncoder().encode("login failed")), 401);
    const clone = response.clone();
    const pending = privateLogin();
    let timeout: ReturnType<typeof setTimeout> | undefined;

    try {
      await expect(
        Promise.race([
          pending,
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(() => reject(new Error("login cancellation stalled")), 1_000);
          }),
        ]),
      ).rejects.toMatchObject({
        name: "UrbitAuthError",
        message: "Login failed with status 401",
      });
    } finally {
      clearTimeout(timeout);
      void clone.body?.cancel().catch(() => undefined);
      await pending.catch(() => undefined);
    }
  });
});
