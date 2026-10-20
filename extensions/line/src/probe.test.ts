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

  it("stays healthy and cancels an optional quota body before the probe deadline", async () => {
    vi.useFakeTimers();
    const pending = createPendingLineResponse({ type: "none" });
    const fetchMock = stubProbe(pending.response, webhookResponse(true));
    const probing = probeLineBot("token", 300);
    try {
      await vi.advanceTimersByTimeAsync(200);
      const result = await probing;
      expect(result).toMatchObject({ ok: true, bot: identity });
      expect(result.quota).toBeUndefined();
      // Exhausting the quota slice must leave time for the webhook read.
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(pending.cancel).toHaveBeenCalledOnce();
    } finally {
      await finish(probing, pending);
    }
  });

  it("cancels a stalled bot identity read and reports a timeout", async () => {
    vi.useFakeTimers();
    const pending = createPendingLineResponse(identity);
    const fetchMock = stubLineApiFetch(pending.response);
    const probing = probeLineBot("token", 300);
    try {
      await vi.advanceTimersByTimeAsync(301);
      expect(await probing).toMatchObject({ ok: false, error: "timeout" });
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(pending.cancel).toHaveBeenCalledOnce();
    } finally {
      await finish(probing, pending);
    }
  });

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

  it("stays healthy when the webhook lookup never settles", async () => {
    vi.useFakeTimers();
    const pending = createPendingLineResponse({ endpoint: "https://x", active: true });
    stubWebhook(pending.response);
    const probing = probeLineBot("token", 300);
    try {
      await vi.advanceTimersByTimeAsync(299);
      const result = await probing;
      expect(result).toMatchObject({ ok: true, bot: identity });
      expect(result.webhook).toBeUndefined();
    } finally {
      await finish(probing, pending);
    }
  });
});
