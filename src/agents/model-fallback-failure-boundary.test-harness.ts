import { expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  onTrustedInternalDiagnosticEvent,
  type DiagnosticEventPayload,
} from "../infra/diagnostic-events.js";
import { FailoverError } from "./failover-error.js";
import { isFallbackSummaryError } from "./model-fallback-attempt.js";
import type { runWithModelFallback as runFallback } from "./model-fallback-runner.js";
import { createModelFallbackConfig } from "./test-helpers/model-fallback-config-fixture.js";

type ModelFailoverDiagnostic = Extract<DiagnosticEventPayload, { type: "model.failover" }>;

function captureModelFailoverDiagnostics(): {
  events: ModelFailoverDiagnostic[];
  stop: () => void;
} {
  const events: ModelFailoverDiagnostic[] = [];
  const stop = onTrustedInternalDiagnosticEvent((event) => {
    if (event.type === "model.failover") {
      events.push(event);
    }
  });
  return { events, stop };
}

function makeDiagnosticFallbackConfig(fallbacks: string[]): OpenClawConfig {
  return createModelFallbackConfig("openai/gpt-5.5", fallbacks);
}

type FallbackParams<T> = Parameters<typeof runFallback<T>>[0];
export function registerFallbackFailureBoundaryCases(
  runWithModelFallback: <T>(
    params: Omit<FallbackParams<T>, "provider"> & Partial<Pick<FallbackParams<T>, "provider">>,
  ) => ReturnType<typeof runFallback<T>>,
): void {
  it("does not replay a thrown attempt after the caller reports a committed side effect", async () => {
    const failure = new FailoverError("primary failed after tool start", {
      provider: "openai",
      model: "gpt-5.4",
      reason: "overloaded",
    });
    const run = vi.fn().mockRejectedValue(failure);
    const canFallbackAfterError = vi.fn().mockReturnValue(false);

    await expect(
      runWithModelFallback({
        cfg: makeDiagnosticFallbackConfig(["anthropic/claude-opus-4-7"]),
        model: "gpt-5.4",
        run,
        canFallbackAfterError,
      }),
    ).rejects.toBe(failure);

    expect(run).toHaveBeenCalledTimes(1);
    expect(canFallbackAfterError).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        model: "gpt-5.4",
        error: failure,
      }),
    );
  });

  it("keeps TLS-failed providers excluded across interleaved fallbacks", async () => {
    const diagnostics = captureModelFailoverDiagnostics();
    const run = vi
      .fn()
      .mockRejectedValueOnce(
        new FailoverError("Hostname/IP does not match certificate's altnames", {
          provider: "openai",
          model: "gpt-5.5",
          reason: "tls_certificate",
          code: "ERR_TLS_CERT_ALTNAME_INVALID",
        }),
      )
      .mockRejectedValueOnce(
        new FailoverError("overloaded", {
          provider: "anthropic",
          model: "claude-opus-4-6",
          reason: "overloaded",
        }),
      )
      .mockResolvedValueOnce("must not run");
    let thrown: unknown;

    try {
      await runWithModelFallback({
        cfg: makeDiagnosticFallbackConfig(["anthropic/claude-opus-4-6", "openai/gpt-5.5-mini"]),
        model: "gpt-5.5",
        sessionId: "session:tls-provider-exclusion",
        sessionKey: "agent:test:tls-provider-exclusion",
        lane: "main",
        run,
      });
    } catch (error) {
      thrown = error;
    } finally {
      diagnostics.stop();
    }

    expect(isFallbackSummaryError(thrown)).toBe(true);
    expect(run.mock.calls).toMatchObject([
      ["openai", "gpt-5.5", { isFinalFallbackAttempt: false }],
      ["anthropic", "claude-opus-4-6", { isFinalFallbackAttempt: true }],
    ]);
    expect(diagnostics.events).toHaveLength(1);
    expect(diagnostics.events).toMatchObject([
      {
        fromProvider: "openai",
        fromModel: "gpt-5.5",
        toProvider: "anthropic",
        toModel: "claude-opus-4-6",
        reason: "tls_certificate",
      },
    ]);
  });
}
