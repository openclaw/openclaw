import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { beforeEach, expect, it, vi } from "vitest";
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
const scryOptions = { path: "/inbox.json", auditContext: "test" };
const scry = () => scryUrbitPath({ ...fetchOptions, cookie: "proof" }, scryOptions);
function mockResponse(response: Response, release = vi.fn(async () => {}), refresh?: () => void) {
  const guarded = { response, finalUrl, release, refreshTimeout: refresh };
  vi.mocked(fetchWithSsrFGuard).mockResolvedValue(guarded);
  return release;
}
const streamResponse = (source: UnderlyingSource<Uint8Array>) =>
  new Response(new ReadableStream(source));
const cancellationFailure = () =>
  streamResponse({
    cancel() {
      throw new Error("cancel failed");
    },
  });
beforeEach(() => vi.mocked(fetchWithSsrFGuard).mockReset());
it("keeps responses alive until release and preserves guarded metadata", async () => {
  const events: string[] = [];
  const response = streamResponse({
    cancel: () => {
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
  expect(vi.mocked(fetchWithSsrFGuard).mock.lastCall?.[0]).toMatchObject({
    signal: controller.signal,
    policy: { allowPrivateNetwork: true },
  });
  await guarded.release();
  expect(events).toEqual(["cancel", "release"]);
});

it.each([
  ["consumed", () => new Response("finished")],
  ["empty", () => new Response(null, { status: 204 })],
  ["cancel-failure", cancellationFailure],
] as const)("releases a %s response", async (kind, makeResponse) => {
  const response = makeResponse();
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

it.each(["fetch", "malformed-scry"])("releases %s with a retained clone", async (owner) => {
  const response =
    owner === "malformed-scry"
      ? new Response("{not json")
      : streamResponse({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("still streaming"));
          },
        });
  const clone = response.clone();
  const release = mockResponse(response);
  try {
    if (owner === "fetch") {
      const guarded = await urbitFetch(fetchOptions);
      const releasing = guarded.release();
      expect(release).toHaveBeenCalledOnce();
      await expect(releasing).resolves.toBeUndefined();
    } else {
      await expect(scry()).rejects.toThrow(
        "Tlon scry response for path /inbox.json: malformed JSON response",
      );
      expect(release).toHaveBeenCalledOnce();
    }
  } finally {
    void clone.body?.cancel().catch(() => undefined);
  }
});
