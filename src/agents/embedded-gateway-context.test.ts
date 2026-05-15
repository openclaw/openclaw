import { afterEach, describe, expect, it } from "vitest";
import {
  clearFallbackGatewayContext,
  dispatchGatewayMethodInProcessRaw,
} from "../gateway/server-plugins.js";
import type { RuntimeEnv } from "../runtime.js";
import {
  buildEmbeddedGatewayContext,
  withEmbeddedGatewayContext,
} from "./embedded-gateway-context.js";

function fakeRuntime(): RuntimeEnv {
  return {
    log: () => {},
    error: () => {},
    debug: () => {},
    warn: () => {},
    exit: () => {},
    info: () => {},
  } as unknown as RuntimeEnv;
}

describe("buildEmbeddedGatewayContext", () => {
  it("returns an object with all required state Maps initialized empty", () => {
    const ctx = buildEmbeddedGatewayContext({ runtime: fakeRuntime() });
    expect(ctx.agentRunSeq).toBeInstanceOf(Map);
    expect(ctx.chatAbortControllers).toBeInstanceOf(Map);
    expect(ctx.chatAbortedRuns).toBeInstanceOf(Map);
    expect(ctx.chatRunBuffers).toBeInstanceOf(Map);
    expect(ctx.dedupe).toBeInstanceOf(Map);
    expect(ctx.bufferedAgentEvents).toBeInstanceOf(Map);
    expect(ctx.wizardSessions).toBeInstanceOf(Map);
    expect(ctx.agentRunSeq.size).toBe(0);
    expect(ctx.dedupe.size).toBe(0);
  });

  it("getRuntimeConfig is wired to the real config getter", () => {
    const ctx = buildEmbeddedGatewayContext({ runtime: fakeRuntime() });
    const cfg = ctx.getRuntimeConfig();
    expect(cfg).toBeTypeOf("object");
  });

  it("broadcast / nodeSendToSession / connId hooks are callable no-ops", () => {
    const ctx = buildEmbeddedGatewayContext({ runtime: fakeRuntime() });
    expect(() => ctx.broadcast({} as never)).not.toThrow();
    expect(() => ctx.nodeSendToSession("k", "e", {})).not.toThrow();
    expect(() => ctx.broadcastToConnIds(new Set(), {} as never)).not.toThrow();
    expect(ctx.getSessionEventSubscriberConnIds().size).toBe(0);
    expect(ctx.hasConnectedTalkNode()).toBe(false);
  });

  it("logGateway routes through subsystem logger (no throw)", () => {
    const ctx = buildEmbeddedGatewayContext({ runtime: fakeRuntime() });
    expect(() => ctx.logGateway.info("test")).not.toThrow();
    expect(() => ctx.logGateway.warn("test")).not.toThrow();
    expect(() => ctx.logGateway.error("test")).not.toThrow();
  });

  it("threads provided deps through (used by server-methods/agent.ts agentCommandFromIngress)", () => {
    const fakeDeps = { __marker: "embedded-deps-fixture" } as unknown as Parameters<
      typeof buildEmbeddedGatewayContext
    >[0]["deps"];
    const ctx = buildEmbeddedGatewayContext({ runtime: fakeRuntime(), deps: fakeDeps });
    expect(ctx.deps).toBe(fakeDeps);
  });

  it("returns an empty deps stub when none is provided (caller responsibility)", () => {
    const ctx = buildEmbeddedGatewayContext({ runtime: fakeRuntime() });
    expect(ctx.deps).toBeDefined();
  });
});

describe("regression #82140 -- raw dispatch error shape", () => {
  afterEach(() => {
    clearFallbackGatewayContext();
  });

  it("dispatchGatewayMethodInProcessRaw error message is byte-identical to the issue stderr", async () => {
    // The issue reporter quoted this exact string in their stderr; this test
    // locks the format so future refactors do not regress the diagnostic.
    clearFallbackGatewayContext();
    let actualMessage: string | undefined;
    try {
      await dispatchGatewayMethodInProcessRaw("agent", { message: "hi" });
    } catch (err) {
      actualMessage = err instanceof Error ? err.message : String(err);
    }
    expect(actualMessage).toBe(
      "In-process gateway dispatch requires a gateway request scope (method: agent). No scope set and no fallback context available.",
    );
  });
});

describe("withEmbeddedGatewayContext", () => {
  afterEach(() => {
    clearFallbackGatewayContext();
  });

  it("installs fallback gateway context for the duration of `work`", async () => {
    clearFallbackGatewayContext();
    let dispatchErrorDuringWork: unknown;
    await withEmbeddedGatewayContext({ runtime: fakeRuntime() }, async () => {
      try {
        await dispatchGatewayMethodInProcessRaw("nodes.list", {});
      } catch (err) {
        dispatchErrorDuringWork = err;
      }
    });
    // Whatever happened inside `work`, it MUST NOT be the scope-check throw.
    if (dispatchErrorDuringWork instanceof Error) {
      expect(dispatchErrorDuringWork.message).not.toMatch(
        /No scope set and no fallback context available\./,
      );
    }
  });

  it("cleans up fallback context after `work` resolves", async () => {
    clearFallbackGatewayContext();
    await withEmbeddedGatewayContext({ runtime: fakeRuntime() }, async () => {
      // no-op work
    });
    // After cleanup, dispatch should throw the scope error again.
    await expect(dispatchGatewayMethodInProcessRaw("nodes.list", {})).rejects.toThrowError(
      /No scope set and no fallback context available\./,
    );
  });

  it("cleans up fallback context after `work` throws", async () => {
    clearFallbackGatewayContext();
    const sentinel = new Error("synthetic failure inside work");
    await expect(
      withEmbeddedGatewayContext({ runtime: fakeRuntime() }, async () => {
        throw sentinel;
      }),
    ).rejects.toThrowError(sentinel);
    // Cleanup must still have run.
    await expect(dispatchGatewayMethodInProcessRaw("nodes.list", {})).rejects.toThrowError(
      /No scope set and no fallback context available\./,
    );
  });

  it("returns the value resolved by `work`", async () => {
    clearFallbackGatewayContext();
    const result = await withEmbeddedGatewayContext({ runtime: fakeRuntime() }, async () => 42);
    expect(result).toBe(42);
  });
});
