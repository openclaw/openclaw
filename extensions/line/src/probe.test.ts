import { afterEach, describe, expect, it, vi } from "vitest";
import { probeLineBot } from "./probe.js";
import { createPendingLineResponse, stubLineApiFetch } from "./probe.test-support.js";
import type { LineMessageQuota } from "./types.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("probeLineBot", () => {
  const identity = { displayName: "bot", userId: "U0", basicId: "@bot" };
  const webhookResponse = (active: boolean) =>
    Response.json({ endpoint: "https://gateway.example/line/webhook", active });
  const stubProbe = (...responses: Parameters<typeof stubLineApiFetch>) =>
    stubLineApiFetch(Response.json(identity), ...responses);
  const stubWebhook = (response: Response) => stubProbe(Response.json({ type: "none" }), response);
  async function finish(
    probing: Promise<unknown>,
    ...bodies: ReturnType<typeof createPendingLineResponse>[]
  ) {
    for (const body of bodies) {
      body.finish();
    }
    await vi.runAllTimersAsync();
    await probing;
  }

  it.each([
    ["identity", 0, 301, { ok: false, error: "timeout" }],
    ["quota", 1, 200, { ok: true, bot: identity }],
    ["webhook", 2, 299, { ok: true, bot: identity }],
  ] as const)(
    "bounds a stalled %s body without spending another read's budget",
    async (stage, index, advanceMs, expected) => {
      vi.useFakeTimers();
      const values = [identity, { type: "none" }, { endpoint: "https://x", active: true }];
      const pending = createPendingLineResponse(values[index]);
      const responses = values.map((value) => Response.json(value));
      responses[index] = pending.response;
      const fetchMock = stubLineApiFetch(...responses.slice(0, index === 0 ? 1 : 3));
      const probing = probeLineBot("token", 300);
      try {
        await vi.advanceTimersByTimeAsync(advanceMs);
        const result = await probing;
        expect(result).toMatchObject(expected);
        if (stage !== "identity") {
          expect(result[stage]).toBeUndefined();
        }
        if (stage !== "webhook") {
          expect(fetchMock).toHaveBeenCalledTimes(index === 0 ? 1 : 3);
          expect(pending.cancel).toHaveBeenCalledOnce();
        }
      } finally {
        await finish(probing, pending);
      }
    },
  );

  it("keeps a limited response without an amount unknown", async () => {
    const fetchMock = stubProbe(Response.json({ type: "limited" }), webhookResponse(true));

    const result = await probeLineBot("token", 5000);
    expect(result).toMatchObject({ ok: true, bot: identity });
    expect(result.quota).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("shares the optional quota deadline across both response bodies", async () => {
    vi.useFakeTimers();
    const bodies: ReturnType<typeof createPendingLineResponse>[] = [];
    const delayedBody = (value: unknown) => () => {
      const pending = createPendingLineResponse(value);
      bodies.push(pending);
      setTimeout(pending.finish, 1200);
      return pending.response;
    };
    const fetchMock = stubProbe(
      delayedBody({ type: "limited", value: 200 }),
      delayedBody({ totalUsage: 70 }),
      webhookResponse(true),
    );
    const completed: Array<LineMessageQuota | undefined> = [];
    // Identity leaves a two-second quota budget; renewing it for consumption would take 2.4s.
    const reading = probeLineBot("token", 4000).then((result) => {
      completed.push(result.quota);
      return result;
    });
    try {
      await vi.advanceTimersByTimeAsync(2001);
      expect(fetchMock).toHaveBeenCalledTimes(4);
      expect(bodies).toHaveLength(2);
      expect(completed).toEqual([undefined]);
      expect(await reading).toMatchObject({ ok: true, bot: identity });
      expect(bodies[1]?.cancel).toHaveBeenCalledOnce();
    } finally {
      await finish(reading, ...bodies);
    }
  });

  it("reports a disabled webhook without exposing the registered URL", async () => {
    stubWebhook(webhookResponse(false));
    const result = await probeLineBot("token", 5000);
    expect(result.webhook).toEqual({ status: "disabled" });
  });

  it("reports an unregistered webhook when LINE answers 404", async () => {
    stubWebhook(Response.json({ message: "Not found" }, { status: 404 }));

    await expect(probeLineBot("token", 5000)).resolves.toMatchObject({
      webhook: { status: "unset" },
    });
  });

  it("leaves the webhook unreported when active is not a boolean", async () => {
    stubWebhook(Response.json({ endpoint: "https://gateway.example/line/webhook", active: "yes" }));

    const result = await probeLineBot("token", 5000);
    expect(result.ok).toBe(true);
    expect(result.webhook).toBeUndefined();
  });
});
