import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authenticate } from "./urbit/auth.js";
import { urbitFetch } from "./urbit/fetch.js";

// mock-isolation: Supply login outcomes without creating real Urbit sessions.
vi.mock("./urbit/auth.js", () => ({ authenticate: vi.fn() }));

// mock-isolation: Inspect runtime requests without making network calls.
vi.mock("./urbit/fetch.js", () => ({ urbitFetch: vi.fn() }));

import { probeTlonAccount, tlonRuntimeOutbound } from "./channel.runtime.js";

const account = {
  accountId: "default",
  configured: true,
  ship: "~zod",
  url: "https://example.com",
  code: "sample-code",
} as never;

const sendText = tlonRuntimeOutbound.sendText;
if (!sendText) {
  throw new Error("Tlon runtime outbound sendText is unavailable");
}

describe("tlonRuntimeOutbound", () => {
  it.each([
    {
      name: "all default account fields",
      cfg: { channels: { tlon: {} } },
      accountId: "default",
      expected: "Tlon account default not configured (missing ship, url, code)",
    },
    {
      name: "one inherited named account field",
      cfg: {
        channels: {
          tlon: { ship: "~zod", url: "https://example.com", accounts: { work: { code: "" } } },
        },
      },
      accountId: "work",
      expected: "Tlon account work not configured (missing code)",
    },
  ])("reports $name when outbound setup is incomplete", async ({ cfg, accountId, expected }) => {
    await expect(sendText({ cfg, to: "~sampel-palnet", text: "hello", accountId })).rejects.toThrow(
      expected,
    );
  });
});

function mockProbeResponse(response: Response, events: string[]) {
  const release = vi.fn(async () => {
    void response.body?.cancel().catch(() => undefined);
    events.push("release");
  });
  vi.mocked(urbitFetch).mockResolvedValue({
    response,
    finalUrl: "https://example.com/~/name",
    release,
    refreshTimeout: vi.fn(),
  });
  return release;
}

function expectCleanup(cancel: unknown, release: unknown, events: string[]) {
  expect(cancel).toHaveBeenCalledOnce();
  expect(release).toHaveBeenCalledOnce();
  expect(events).toEqual(["cancel", "release"]);
}

describe("probeTlonAccount", () => {
  afterEach(() => vi.useRealTimers());

  beforeEach(() => {
    vi.mocked(authenticate).mockReset().mockResolvedValue("urbauth-~zod=fake-cookie");
    vi.mocked(urbitFetch).mockReset();
  });

  it.each([
    { status: 200, cancelFails: false, expected: { ok: true } },
    { status: 503, cancelFails: false, expected: { ok: false, error: "Name request failed: 503" } },
    { status: 200, cancelFails: true, expected: { ok: true } },
  ])(
    "releases a $status response guard (cancelFails=$cancelFails)",
    async ({ status, cancelFails, expected }) => {
      const events: string[] = [];
      const cancelBody = vi.fn(() => {
        events.push("cancel");
        if (cancelFails) {
          throw new Error("cancel failed");
        }
      });
      const response = new Response(new ReadableStream<Uint8Array>({ cancel: cancelBody }), {
        status,
      });
      const release = mockProbeResponse(response, events);

      await expect(probeTlonAccount(account)).resolves.toEqual({
        ...expected,
        elapsedMs: expect.any(Number),
      });

      expectCleanup(cancelBody, release, events);
    },
  );

  it("honors the status adapter timeout", async () => {
    vi.useFakeTimers();
    vi.mocked(authenticate).mockReturnValueOnce(new Promise(() => {}));

    const pending = probeTlonAccount(account, 50);
    await vi.advanceTimersByTimeAsync(50);

    await expect(pending).resolves.toEqual({ ok: false, error: "timeout", elapsedMs: 50 });
  });
});
