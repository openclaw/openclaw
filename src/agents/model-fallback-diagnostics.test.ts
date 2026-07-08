/**
 * Regression tests for model.failover diagnostic emission on fallback transitions.
 *
 * Verifies that observeFailedCandidate emits model.failover events for
 * actual candidate-to-candidate transitions, and suppresses emission for
 * single-model runs and terminal (exhausted) candidates.
 *
 * See PR #102051, issue #102015.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  onTrustedInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  type DiagnosticEventPayload,
} from "../infra/diagnostic-events.js";
import { runWithModelFallback } from "./model-fallback.js";
import { FailoverError } from "./failover-error.js";

afterEach(() => {
  resetDiagnosticEventsForTest();
});

const CFG_WITH_FALLBACK = {
  agents: {
    defaults: {
      model: {
        primary: "openai/gpt-5.5",
        fallbacks: ["anthropic/claude-opus-4-6"],
      },
    },
  },
} as any;

const CFG_NO_FALLBACK = {
  agents: {
    defaults: {
      model: {
        primary: "openai/gpt-5.5",
      },
    },
  },
} as any;

describe("model.failover diagnostic emission", () => {
  it("emits model.failover when primary fails and fallback succeeds", async () => {
    resetDiagnosticEventsForTest();
    const failoverEvents: Array<
      Extract<DiagnosticEventPayload, { type: "model.failover" }>
    > = [];
    const unsubscribe = onTrustedInternalDiagnosticEvent((event) => {
      if (event.type === "model.failover") {
        failoverEvents.push(event);
      }
    });

    try {
      const run = vi
        .fn()
        .mockRejectedValueOnce(
          new FailoverError("rate limited", {
            provider: "openai",
            model: "gpt-5.5",
            reason: "rate_limit",
          }),
        )
        .mockResolvedValueOnce("ok");

      const result = await runWithModelFallback({
        cfg: CFG_WITH_FALLBACK,
        provider: "openai",
        model: "gpt-5.5",
        sessionId: "session:test",
        sessionKey: "agent:test",
        lane: "main",
        run,
      });

      expect(result.result).toBe("ok");
      expect(failoverEvents).toHaveLength(1);

      const evt = failoverEvents[0];
      expect(evt.type).toBe("model.failover");
      expect(evt.sessionId).toBe("session:test");
      expect(evt.lane).toBe("main");
      expect(evt.fromProvider).toBe("openai");
      expect(evt.fromModel).toBe("gpt-5.5");
      expect(evt.toProvider).toBe("anthropic");
      expect(evt.toModel).toBe("claude-opus-4-6");
      expect(evt.reason).toBe("rate_limit");
      expect(evt.cascadeDepth).toBe(0);
      expect(evt.suspended).toBe(false);
    } finally {
      unsubscribe();
      resetDiagnosticEventsForTest();
    }
  });

  it("does NOT emit model.failover for single-model run (no fallback configured)", async () => {
    resetDiagnosticEventsForTest();
    const failoverEvents: Array<
      Extract<DiagnosticEventPayload, { type: "model.failover" }>
    > = [];
    const unsubscribe = onTrustedInternalDiagnosticEvent((event) => {
      if (event.type === "model.failover") {
        failoverEvents.push(event);
      }
    });

    try {
      const result = await runWithModelFallback({
        cfg: CFG_NO_FALLBACK,
        provider: "openai",
        model: "gpt-5.5",
        sessionId: "session:test-no-fallback",
        run: vi.fn().mockResolvedValue("ok"),
      });

      expect(result.result).toBe("ok");
      expect(failoverEvents).toHaveLength(0);
    } finally {
      unsubscribe();
      resetDiagnosticEventsForTest();
    }
  });

  it("does NOT emit false model.failover for terminal exhausted candidate", async () => {
    resetDiagnosticEventsForTest();
    const failoverEvents: Array<
      Extract<DiagnosticEventPayload, { type: "model.failover" }>
    > = [];
    const unsubscribe = onTrustedInternalDiagnosticEvent((event) => {
      if (event.type === "model.failover") {
        failoverEvents.push(event);
      }
    });

    try {
      const run = vi
        .fn()
        .mockRejectedValue(
          new FailoverError("always overloaded", {
            provider: "openai",
            model: "gpt-5.5",
            reason: "overloaded",
          }),
        );

      let exhausted = false;
      try {
        await runWithModelFallback({
          cfg: CFG_WITH_FALLBACK,
          provider: "openai",
          model: "gpt-5.5",
          sessionId: "session:test-exhausted",
          run,
        });
      } catch {
        exhausted = true;
      }
      expect(exhausted).toBe(true);

      // Exactly one event for the primary→fallback transition.
      // No event for the last (fallback→exhausted) because
      // nextCandidate is undefined at that point.
      expect(failoverEvents).toHaveLength(1);
      expect(failoverEvents[0].toModel).toBe("claude-opus-4-6");
      expect(failoverEvents[0].suspended).toBe(false);
    } finally {
      unsubscribe();
      resetDiagnosticEventsForTest();
    }
  });
});
