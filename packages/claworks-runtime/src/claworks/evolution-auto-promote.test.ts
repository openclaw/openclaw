import { describe, expect, it, vi } from "vitest";
import {
  registerEvolutionAutoPromoteHandler,
  shouldAutoPromoteSandbox,
} from "./evolution-auto-promote.js";

describe("shouldAutoPromoteSandbox", () => {
  it("returns false by default", () => {
    expect(shouldAutoPromoteSandbox({})).toBe(false);
  });

  it("returns true when evolution.auto_promote_sandbox is true in dev", () => {
    expect(shouldAutoPromoteSandbox({ evolution: { auto_promote_sandbox: true } }, {})).toBe(true);
  });

  it("returns false in production_mode even when flag is true", () => {
    expect(
      shouldAutoPromoteSandbox(
        { production_mode: true, evolution: { auto_promote_sandbox: true } },
        {},
      ),
    ).toBe(false);
  });

  it("returns false when CLAWORKS_PRODUCTION=1 and flag is true", () => {
    expect(
      shouldAutoPromoteSandbox(
        { evolution: { auto_promote_sandbox: true } },
        {
          CLAWORKS_PRODUCTION: "1",
        },
      ),
    ).toBe(false);
  });
});

describe("registerEvolutionAutoPromoteHandler", () => {
  it("promotes sandbox when flag enabled and event fires", async () => {
    const handlers = new Map<
      string,
      Array<(event: { payload?: Record<string, unknown> }) => void>
    >();
    const promoteSandbox = vi.fn().mockResolvedValue({ status: "promoted" });
    const runtime = {
      config: { evolution: { auto_promote_sandbox: true } },
      evolutionSync: { promoteSandbox },
      kernel: {
        bus: {
          subscribe(type: string, handler: (event: { payload?: Record<string, unknown> }) => void) {
            const list = handlers.get(type) ?? [];
            list.push(handler);
            handlers.set(type, list);
          },
        },
      },
      logger: vi.fn(),
    };

    registerEvolutionAutoPromoteHandler(runtime as never);

    const list = handlers.get("evolution.sandbox_ready_for_promotion") ?? [];
    expect(list.length).toBe(1);

    await list[0]!({ payload: { promotion_id: "promo-abc" } });

    expect(promoteSandbox).toHaveBeenCalledWith({
      promotion_id: "promo-abc",
      approved: true,
      source: "runtime.auto_promote_sandbox",
    });
  });

  it("does not subscribe when flag disabled", () => {
    const subscribe = vi.fn();
    const runtime = {
      config: {},
      kernel: { bus: { subscribe } },
      logger: vi.fn(),
    };

    registerEvolutionAutoPromoteHandler(runtime as never);
    expect(subscribe).not.toHaveBeenCalled();
  });
});
