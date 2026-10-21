import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { urbitFetch } from "./fetch.js";

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async () => ({
  ...(await vi.importActual<typeof import("openclaw/plugin-sdk/ssrf-runtime")>(
    "openclaw/plugin-sdk/ssrf-runtime",
  )),
  fetchWithSsrFGuard: vi.fn(),
}));

const finalUrl = "https://example.com/~/channel/1701";
const fetchOptions = { baseUrl: "https://example.com", path: "/~/channel/1701" };
function mockResponse(response: Response, release = vi.fn(async () => {}), refresh?: () => void) {
  const guarded = { response, finalUrl, release, refreshTimeout: refresh };
  vi.mocked(fetchWithSsrFGuard).mockResolvedValue(guarded);
  return release;
}
async function expectReleased(response: Response) {
  const release = mockResponse(response);
  const guarded = await urbitFetch(fetchOptions);
  await expect(guarded.release()).resolves.toBeUndefined();
  expect(release).toHaveBeenCalledOnce();
}
const streamResponse = (source: UnderlyingSource<Uint8Array>) =>
  new Response(new ReadableStream(source));

describe("urbitFetch guarded response ownership", () => {
  beforeEach(() => {
    vi.mocked(fetchWithSsrFGuard).mockReset();
  });

  it("keeps responses alive until release and preserves guarded metadata", async () => {
    const events: string[] = [];
    const response = streamResponse({
      cancel() {
        events.push("cancel");
      },
    });
    const release = vi.fn(async () => {
      events.push("release");
    });
    const refreshTimeout = vi.fn();
    const controller = new AbortController();
    mockResponse(response, release, refreshTimeout);

    const guarded = await urbitFetch({
      ...fetchOptions,
      signal: controller.signal,
      ssrfPolicy: { allowPrivateNetwork: true },
    });

    expect(guarded.response).toBe(response);
    expect(guarded.finalUrl).toBe(finalUrl);
    expect(guarded.refreshTimeout).toBe(refreshTimeout);
    expect(events).toEqual([]);
    expect(fetchWithSsrFGuard).toHaveBeenCalledWith(
      expect.objectContaining({
        signal: controller.signal,
        policy: { allowPrivateNetwork: true },
      }),
    );

    await guarded.release();

    expect(events).toEqual(["cancel", "release"]);
    expect(release).toHaveBeenCalledOnce();
  });

  it("does not cancel a response that its owner already consumed", async () => {
    const response = new Response("finished");
    const body = response.body;
    if (!body) {
      throw new Error("expected a response body");
    }
    const cancel = vi.spyOn(body, "cancel");
    const release = mockResponse(response);
    const guarded = await urbitFetch(fetchOptions);
    await expect(guarded.response.text()).resolves.toBe("finished");
    await guarded.release();

    expect(cancel).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });

  it("releases a successful response without a body", async () => {
    await expectReleased(new Response(null, { status: 204 }));
  });

  it("releases promptly when a retained response clone keeps cancellation pending", async () => {
    const response = streamResponse({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("still streaming"));
      },
    });
    const clone = response.clone();
    const release = mockResponse(response);
    const guarded = await urbitFetch(fetchOptions);
    const releasing = guarded.release();

    try {
      expect(release).toHaveBeenCalledOnce();
      await expect(releasing).resolves.toBeUndefined();
    } finally {
      void clone.body?.cancel().catch(() => undefined);
    }
  });

  it("still releases when response cancellation rejects", async () => {
    await expectReleased(
      streamResponse({
        cancel() {
          throw new Error("cancel failed");
        },
      }),
    );
  });
});
