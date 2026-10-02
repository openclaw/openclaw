import { describe, expect, it, vi } from "vitest";
import { runWithModelFallback } from "../../model-fallback-runner.js";
import { recordModelFallbackStop } from "../../model-fallback-stop.js";
import { recoverAfterTransportDrop } from "./attempt-recovery.test-support.js";

describe("Codex transport recovery and model fallback", () => {
  it.each([true, false])(
    "surfaces exhausted native transport recovery without continuation or fallback (replay safe: %s)",
    async (replaySafe) => {
      const error = new Error("stream disconnected before completion");
      recordModelFallbackStop(error);
      const run = vi.fn(async () =>
        recoverAfterTransportDrop({
          terminal: { kind: "failed", source: "prompt", error },
          pluginHarnessOwnsTransport: true,
          fallbackConfigured: true,
          noTools: replaySafe,
          replaySafe,
          content: [],
        }),
      );
      await expect(
        runWithModelFallback({
          provider: "fixture-primary",
          model: "fixture-model",
          manifestPlugins: [],
          fallbacksOverride: ["fixture-secondary/fixture-model"],
          run,
        }),
      ).rejects.toBe(error);
      expect(run).toHaveBeenCalledOnce();
    },
  );

  it.each([
    { transport: "websocket", replaySafe: true, retryAvailable: true },
    { transport: "websocket", replaySafe: false, retryAvailable: true },
    { transport: "stdio", replaySafe: true, retryAvailable: false },
    { transport: "stdio", replaySafe: false, retryAvailable: true },
  ] as const)(
    "keeps $transport connection loss out of model fallback (replay safe: $replaySafe, retry available: $retryAvailable)",
    async ({ transport, replaySafe, retryAvailable }) => {
      const error = new Error("codex app-server client closed before turn completed");
      const run = vi.fn(async () =>
        recoverAfterTransportDrop({
          terminal: { kind: "failed", source: "prompt", error },
          codexAppServerFailure: {
            kind: "client_closed_before_turn_completed",
            transport,
            threadId: "thread-disconnected",
            turnId: "turn-disconnected",
            replaySafe,
          },
          codexAppServerRecoveryRetryAvailable: retryAvailable,
          pluginHarnessOwnsTransport: true,
          fallbackConfigured: true,
          noTools: replaySafe,
          replaySafe,
          content: [],
        }),
      );

      await expect(
        runWithModelFallback({
          provider: "fixture-primary",
          model: "fixture-model",
          manifestPlugins: [],
          fallbacksOverride: ["fixture-secondary/fixture-model"],
          run,
        }),
      ).rejects.toBe(error);
      expect(run).toHaveBeenCalledOnce();
      expect(run.mock.calls[0]?.slice(0, 2)).toEqual(["fixture-primary", "fixture-model"]);
    },
  );

  it("retains the bounded same-model recovery for replay-safe stdio connection loss", async () => {
    const { recovery } = await recoverAfterTransportDrop({
      terminal: {
        kind: "failed",
        source: "prompt",
        error: new Error("codex app-server client closed before turn completed"),
      },
      codexAppServerFailure: {
        kind: "client_closed_before_turn_completed",
        transport: "stdio",
        threadId: "thread-disconnected",
        turnId: "turn-disconnected",
        replaySafe: true,
      },
      codexAppServerRecoveryRetryAvailable: true,
      pluginHarnessOwnsTransport: true,
      noTools: true,
      replaySafe: true,
      content: [],
    });
    expect(recovery).toMatchObject({ action: "retry", codexAppServerRecoveryRetries: 1 });
  });
});
