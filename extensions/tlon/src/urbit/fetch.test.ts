import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { scryUrbitPath } from "./channel-ops.js";
import { urbitFetch } from "./fetch.js";

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async () => ({
  ...(await vi.importActual<typeof import("openclaw/plugin-sdk/ssrf-runtime")>(
    "openclaw/plugin-sdk/ssrf-runtime",
  )),
  fetchWithSsrFGuard: vi.fn(),
}));

const finalUrl = "https://example.com/~/channel/1701";
const fetchOptions = { baseUrl: "https://example.com", path: "/~/channel/1701" };
const scry = () =>
  scryUrbitPath(
    { ...fetchOptions, cookie: "proof" },
    {
      path: "/inbox.json",
      auditContext: "test",
    },
  );
function mockResponse(response: Response, release = vi.fn(async () => {}), refresh?: () => void) {
  const guarded = { response, finalUrl, release, refreshTimeout: refresh };
  vi.mocked(fetchWithSsrFGuard).mockResolvedValue(guarded);
  return release;
}
const streamResponse = (source: UnderlyingSource<Uint8Array>, status = 200) =>
  new Response(new ReadableStream(source), { status });

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

  it.each(["consumed", "empty", "cancel-failure"])("releases a %s response", async (kind) => {
    const response =
      kind === "consumed"
        ? new Response("finished")
        : kind === "empty"
          ? new Response(null, { status: 204 })
          : streamResponse({
              cancel() {
                throw new Error("cancel failed");
              },
            });
    const cancel = response.body ? vi.spyOn(response.body, "cancel") : undefined;
    const release = mockResponse(response);
    const guarded = await urbitFetch(fetchOptions);
    if (kind === "consumed") {
      await expect(guarded.response.text()).resolves.toBe("finished");
    }
    await expect(guarded.release()).resolves.toBeUndefined();
    if (kind === "consumed") {
      expect(cancel).not.toHaveBeenCalled();
    }
    expect(release).toHaveBeenCalledOnce();
  });

  it.each(["fetch", "scry", "malformed-scry"])(
    "releases %s with a retained clone",
    async (owner) => {
      const response =
        owner === "malformed-scry"
          ? new Response("{not json")
          : streamResponse(
              {
                start(controller) {
                  controller.enqueue(new TextEncoder().encode("still streaming"));
                },
              },
              owner === "scry" ? 500 : 200,
            );
      const clone = response.clone();
      const release = mockResponse(response);
      try {
        if (owner === "fetch") {
          const guarded = await urbitFetch(fetchOptions);
          const releasing = guarded.release();
          expect(release).toHaveBeenCalledOnce();
          await expect(releasing).resolves.toBeUndefined();
        } else {
          const error =
            owner === "scry"
              ? "Scry for path /inbox.json"
              : "Tlon scry response for path /inbox.json: malformed JSON response";
          await expect(scry()).rejects.toThrow(error);
        }
        expect(release).toHaveBeenCalledOnce();
      } finally {
        void clone.body?.cancel().catch(() => undefined);
      }
    },
  );
});
