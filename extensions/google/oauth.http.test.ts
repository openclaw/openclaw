// Google tests cover oauth.http body-byte-cap for the Gemini CLI OAuth
// token-exchange/identity calls.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TOKEN_URL } from "./oauth.shared.js";

const fetchWithSsrFGuardMock = vi.fn();
const releaseMock = vi.fn(async () => undefined);

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/ssrf-runtime")>(
    "openclaw/plugin-sdk/ssrf-runtime",
  );
  return {
    ...actual,
    fetchWithSsrFGuard: (params: unknown) => fetchWithSsrFGuardMock(params),
  };
});

const { fetchWithTimeout } = await import("./oauth.http.js");

describe("oauth.http fetchWithTimeout body byte cap", () => {
  beforeEach(() => {
    fetchWithSsrFGuardMock.mockReset();
    releaseMock.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("caps oversized response body at 16 MiB with labeled overflow error", async () => {
    // Build a Response with a body that exceeds the 16 MiB cap.
    // 1 MiB chunks × 18 chunks = 18 MiB queued; the bounded reader reads
    // up to the 16 MiB cap (16 chunks = 16777216 bytes) and one extra
    // chunk before throwing on overflow, so the labeled `size` is the
    // cap plus the trailing chunk: 16777216 + 1048576 = 17825792 bytes.
    const CHUNK = 1024 * 1024;
    let sent = 0;
    const body = new ReadableStream({
      pull(controller) {
        if (sent < 18) {
          controller.enqueue(new Uint8Array(CHUNK));
          sent++;
        } else {
          controller.close();
        }
      },
    });
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response(body, {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      finalUrl: TOKEN_URL,
      release: releaseMock,
    });

    await expect(fetchWithTimeout(TOKEN_URL, { method: "POST" })).rejects.toThrow(
      /google HTTP fetch: body exceeds 16777216 bytes \(got 17825792\)/,
    );
    expect(releaseMock).toHaveBeenCalledOnce();
  });

  it("returns a Response for normal-size bodies", async () => {
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response('{"access_token":"abc","expires_in":3600}', {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      finalUrl: TOKEN_URL,
      release: releaseMock,
    });

    const res = await fetchWithTimeout(TOKEN_URL, { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ access_token: "abc", expires_in: 3600 });
    expect(releaseMock).toHaveBeenCalledOnce();
  });
});
