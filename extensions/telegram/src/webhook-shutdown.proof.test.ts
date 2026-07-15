import { describe, expect, it } from "vitest";
import { runTelegramWebhookShutdownPhases } from "./webhook-shutdown.js";

interface PhaseLog {
  abort: number;
  drain: number;
  closeServer: number;
  stopBot: number;
  closeTransport: number;
  noteStop: number;
  stopDiagnostics: number;
  errors: string[];
}

function createPhaseTracker(params: {
  closeServer: () => void;
  stopBot?: () => Promise<void>;
  closeTransport?: () => Promise<void>;
}): { log: PhaseLog; phases: Parameters<typeof runTelegramWebhookShutdownPhases>[0] } {
  const log: PhaseLog = {
    abort: 0,
    drain: 0,
    closeServer: 0,
    stopBot: 0,
    closeTransport: 0,
    noteStop: 0,
    stopDiagnostics: 0,
    errors: [],
  };
  return {
    log,
    phases: {
      abortShutdown: () => {
        log.abort += 1;
      },
      clearDrainTimer: () => {
        log.drain += 1;
      },
      closeServer: () => {
        log.closeServer += 1;
        params.closeServer();
      },
      stopBot: async () => {
        log.stopBot += 1;
        await params.stopBot?.();
      },
      closeTransport: async () => {
        log.closeTransport += 1;
        await params.closeTransport?.();
      },
      noteStop: () => {
        log.noteStop += 1;
      },
      stopDiagnostics: () => {
        log.stopDiagnostics += 1;
      },
      onError: (message) => {
        log.errors.push(message);
      },
    },
  };
}

/** Pre-fix nested control flow: sync close throw skips the inner finally. */
async function brokenNestedShutdown(params: {
  closeServer: () => void;
  stopBot: () => Promise<void>;
  closeTransport: () => Promise<void>;
  noteStop: () => void;
  stopDiagnostics: () => void;
  onError: (message: string) => void;
}): Promise<void> {
  try {
    params.closeServer();
    try {
      await params.stopBot();
    } catch (err) {
      params.onError(`webhook shutdown failed: ${String(err)}`);
    } finally {
      await params.closeTransport().catch((err: unknown) => {
        params.onError(`webhook transport close failed: ${String(err)}`);
      });
      params.noteStop();
      params.stopDiagnostics();
    }
  } catch (err) {
    params.onError(`webhook shutdown unexpected error: ${String(err)}`);
  }
}

describe("telegram webhook shutdown real-behavior proof", () => {
  it("negative control: sync server.close throw skips later cleanup", async () => {
    const log: PhaseLog = {
      abort: 0,
      drain: 0,
      closeServer: 0,
      stopBot: 0,
      closeTransport: 0,
      noteStop: 0,
      stopDiagnostics: 0,
      errors: [],
    };
    await brokenNestedShutdown({
      closeServer: () => {
        log.closeServer += 1;
        throw new Error("server close failed");
      },
      stopBot: async () => {
        log.stopBot += 1;
      },
      closeTransport: async () => {
        log.closeTransport += 1;
      },
      noteStop: () => {
        log.noteStop += 1;
      },
      stopDiagnostics: () => {
        log.stopDiagnostics += 1;
      },
      onError: (message) => {
        log.errors.push(message);
      },
    });
    expect(log.closeServer).toBe(1);
    expect(log.stopBot).toBe(0);
    expect(log.closeTransport).toBe(0);
    expect(log.noteStop).toBe(0);
    expect(log.stopDiagnostics).toBe(0);
    expect(log.errors.some((e) => e.includes("unexpected error"))).toBe(true);
    console.log(
      `[case 1] negative control closeServer=${log.closeServer} stopBot=${log.stopBot} closeTransport=${log.closeTransport} noteStop=${log.noteStop} stopDiagnostics=${log.stopDiagnostics} errors=${log.errors.length}`,
    );
  });

  it("positive control: guarded phases continue after sync close throw", async () => {
    const { log, phases } = createPhaseTracker({
      closeServer: () => {
        throw new Error("server close failed");
      },
    });
    await expect(runTelegramWebhookShutdownPhases(phases)).resolves.toBeUndefined();
    expect(log.abort).toBe(1);
    expect(log.drain).toBe(1);
    expect(log.closeServer).toBe(1);
    expect(log.stopBot).toBe(1);
    expect(log.closeTransport).toBe(1);
    expect(log.noteStop).toBe(1);
    expect(log.stopDiagnostics).toBe(1);
    expect(log.errors.some((e) => e.includes("webhook server close failed"))).toBe(true);
    console.log(
      `[case 2] positive control stopBot=${log.stopBot} closeTransport=${log.closeTransport} noteStop=${log.noteStop} stopDiagnostics=${log.stopDiagnostics} errors=${JSON.stringify(log.errors)}`,
    );
  });

  it("valid path: clean close runs full ordered teardown", async () => {
    const { log, phases } = createPhaseTracker({
      closeServer: () => undefined,
    });
    await expect(runTelegramWebhookShutdownPhases(phases)).resolves.toBeUndefined();
    expect(log.abort).toBe(1);
    expect(log.drain).toBe(1);
    expect(log.closeServer).toBe(1);
    expect(log.stopBot).toBe(1);
    expect(log.closeTransport).toBe(1);
    expect(log.noteStop).toBe(1);
    expect(log.stopDiagnostics).toBe(1);
    expect(log.errors).toEqual([]);
    console.log(`[case 3] valid path phases_ok=true errors=${log.errors.length}`);
  });
});
