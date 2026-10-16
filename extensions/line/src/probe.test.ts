// Line tests cover probe plugin behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import { probeLineBot } from "./probe.js";
import { createPendingLineResponse, stubLineApiFetch } from "./probe.test-support.js";
import type { LineMessageQuota } from "./types.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("probeLineBot", () => {
  const identity = {
    displayName: "bot",
    userId: "U0",
    basicId: "@bot",
  };
  // The probe reads the webhook switch after the optional quota reads, so every
  // sequence that gets that far declares its answer rather than falling through to
  // the support stub's unexpected-request guard.
  const webhookResponse = (active: boolean) =>
    Response.json({ endpoint: "https://gateway.example/line/webhook", active });

  it("stays healthy and cancels an optional quota body before the probe deadline", async () => {
    vi.useFakeTimers();
    const pending = createPendingLineResponse({ type: "none" });
    const fetchMock = stubLineApiFetch(
      Response.json(identity),
      pending.response,
      webhookResponse(true),
    );
    const probing = probeLineBot("token", 300);
    try {
      await vi.advanceTimersByTimeAsync(200);
      const result = await probing;
      expect(result).toMatchObject({ ok: true, bot: identity });
      expect(result.quota).toBeUndefined();
      // The stalled quota read spends only its own slice; the webhook read still gets
      // a bounded budget of what remains, so it runs rather than being starved.
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(pending.cancel).toHaveBeenCalledOnce();
    } finally {
      pending.finish();
      await vi.runAllTimersAsync();
      await probing;
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
      pending.finish();
      await vi.runAllTimersAsync();
      await probing;
    }
  });

  it("keeps a limited response without an amount unknown", async () => {
    const fetchMock = stubLineApiFetch(
      Response.json(identity),
      Response.json({ type: "limited" }),
      webhookResponse(true),
    );

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
    const fetchMock = stubLineApiFetch(
      Response.json(identity),
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
      // Three LINE reads plus the webhook read that follows the exhausted quota budget.
      expect(fetchMock).toHaveBeenCalledTimes(4);
      expect(bodies).toHaveLength(2);
      expect(completed).toEqual([undefined]);
      expect(await reading).toMatchObject({ ok: true, bot: identity });
      expect(bodies[1]?.cancel).toHaveBeenCalledOnce();
    } finally {
      for (const pending of bodies) {
        pending.finish();
      }
      await vi.runAllTimersAsync();
      await reading;
    }
  });

  it.each([{ active: false, expected: "disabled" }] as const)(
    "reports a registered webhook that is active=$active",
    async ({ active, expected }) => {
      stubLineApiFetch(
        Response.json(identity),
        Response.json({ type: "none" }),
        webhookResponse(active),
      );

      // LINE returns the registered URL; the probe deliberately does not carry it,
      // because it would then reach logs and status output with no action to take on it.
      const result = await probeLineBot("token", 5000);
      expect(result.webhook).toEqual({ status: expected });
    },
  );

  it("reports an unregistered webhook when LINE answers 404", async () => {
    stubLineApiFetch(
      Response.json(identity),
      Response.json({ type: "none" }),
      Response.json({ message: "Not found" }, { status: 404 }),
    );

    await expect(probeLineBot("token", 5000)).resolves.toMatchObject({
      webhook: { status: "unset" },
    });
  });

  // An answer that is not the documented boolean is not evidence either: reporting it
  // as disabled would send an operator to a console switch that is already on.
  it("leaves the webhook unreported when active is not a boolean", async () => {
    stubLineApiFetch(
      Response.json(identity),
      Response.json({ type: "none" }),
      Response.json({ endpoint: "https://gateway.example/line/webhook", active: "yes" }),
    );

    const result = await probeLineBot("token", 5000);
    expect(result.ok).toBe(true);
    expect(result.webhook).toBeUndefined();
  });

  // The webhook lookup is an optional extra inside the probe's deadline. If it could
  // spend that deadline, a healthy token would be reported as a broken channel.
  it("stays healthy when the webhook lookup never settles", async () => {
    vi.useFakeTimers();
    const pending = createPendingLineResponse({ endpoint: "https://x", active: true });
    stubLineApiFetch(Response.json(identity), Response.json({ type: "none" }), pending.response);
    const probing = probeLineBot("token", 300);
    try {
      await vi.advanceTimersByTimeAsync(299);
      const result = await probing;
      expect(result).toMatchObject({ ok: true, bot: identity });
      expect(result.webhook).toBeUndefined();
    } finally {
      pending.finish();
      await vi.runAllTimersAsync();
      await probing;
    }
  });
});
