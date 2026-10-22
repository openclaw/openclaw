import { beforeEach, describe, expect, it, vi } from "vitest";
import { ensureUrbitChannelOpen, scryUrbitPath } from "./channel-ops.js";
import { urbitFetch } from "./fetch.js";

vi.mock("./fetch.js", () => ({
  urbitFetch: vi.fn(),
}));

const CHANNEL_DEPS = {
  baseUrl: "https://example.com",
  cookie: "urbauth-~zod=123",
  ship: "~zod",
  channelId: "1701",
};
const scry = () => scryUrbitPath(CHANNEL_DEPS, { path: "/chat/inbox.json", auditContext: "test" });
const open = () =>
  ensureUrbitChannelOpen(CHANNEL_DEPS, { createBody: [], createAuditContext: "test" });
function queueResponse(response: Response, release: () => Promise<void>) {
  const finalUrl = "https://example.com/~/channel/1701";
  vi.mocked(urbitFetch).mockResolvedValueOnce({ response, finalUrl, release });
}

function mockGuardedResponse(response: Response) {
  const state = { bodyUsedAtRelease: undefined as boolean | undefined };
  queueResponse(response, async () => {
    if (!response.bodyUsed) {
      void response.body?.cancel().catch(() => undefined);
    }
    state.bodyUsedAtRelease = response.bodyUsed;
  });
  return state;
}

describe("Urbit channel operations", () => {
  beforeEach(() => {
    vi.mocked(urbitFetch).mockReset();
  });

  it("rejects malformed scry response JSON", async () => {
    const release = vi.fn().mockResolvedValue(undefined);
    const response = new Response("{not json", { headers: { "content-type": "application/json" } });
    queueResponse(response, release);
    await expect(scry()).rejects.toThrow(
      "Tlon scry response for path /chat/inbox.json: malformed JSON response",
    );
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("cancels the unread channel creation error body before release", async () => {
    const state = mockGuardedResponse(new Response("ship exploded", { status: 500 }));
    await expect(open()).rejects.toThrow("Channel creation");
    expect(state.bodyUsedAtRelease).toBe(true);
  });

  it("cancels the unread channel activation error body before release", async () => {
    mockGuardedResponse(new Response(null, { status: 204 }));
    const wakeState = mockGuardedResponse(new Response("ship exploded", { status: 500 }));
    await expect(open()).rejects.toThrow("Channel activation");
    expect(wakeState.bodyUsedAtRelease).toBe(true);
  });

  it("releases promptly when error body cancellation never settles", async () => {
    const response = new Response("ship exploded", { status: 500 });
    const body = response.body;
    if (!body) {
      throw new Error("expected a readable error body");
    }
    // A debug-proxy tee can keep cancel() pending; release must not wait for it.
    vi.spyOn(body, "cancel").mockImplementation(() => new Promise<void>(() => {}));
    let released = false;
    const release = vi.fn(async () => {
      void body.cancel().catch(() => undefined);
      released = true;
    });
    queueResponse(response, release);
    await expect(scry()).rejects.toThrow("Scry for path /chat/inbox.json");
    expect(released).toBe(true);
  });
});
