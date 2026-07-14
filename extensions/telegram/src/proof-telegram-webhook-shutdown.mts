/**
 * Real behavior proof: Telegram webhook shutdown continues after sync close throw.
 *
 * Drives production `runTelegramWebhookShutdownPhases` (the webhook shutdown
 * chokepoint) with a synchronous `server.close()` failure — the failure mode
 * ClawSweeper flagged as skipping later owned cleanup.
 *
 * Covers:
 * - Negative control: old nested try/finally skips bot/transport/status/diagnostics
 * - Positive control: guarded phases still run every later cleanup step
 * - Valid path: clean close still runs the full ordered teardown
 */
import { execSync } from "node:child_process";

let passed = 0;
let failed = 0;

function assert(description: string, fn: () => boolean) {
  try {
    if (fn()) {
      passed++;
      console.log("  ok: %s", description);
    } else {
      failed++;
      console.log("  FAIL: %s", description);
    }
  } catch (err) {
    failed++;
    console.log("  FAIL: %s — %s", description, (err as Error).message);
  }
}

const head = (() => {
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
})();

console.log("node=%s", process.version);
console.log("head=%s", head);

const { runTelegramWebhookShutdownPhases } = await import("./webhook-shutdown.js");

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

// ---------------------------------------------------------------------------
// [case 1] Negative control — nested try/finally skips later phases
// ---------------------------------------------------------------------------
console.log("\n[case 1] negative control — sync server.close throw skips later cleanup");
{
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
  assert("closeServer ran once", () => log.closeServer === 1);
  assert("stopBot was skipped", () => log.stopBot === 0);
  assert("closeTransport was skipped", () => log.closeTransport === 0);
  assert("noteStop was skipped", () => log.noteStop === 0);
  assert("stopDiagnostics was skipped", () => log.stopDiagnostics === 0);
  assert("outer catch logged unexpected error", () =>
    log.errors.some((e) => e.includes("unexpected error")),
  );
  console.log(
    "  info: closeServer=%d stopBot=%d closeTransport=%d noteStop=%d stopDiagnostics=%d errors=%d",
    log.closeServer,
    log.stopBot,
    log.closeTransport,
    log.noteStop,
    log.stopDiagnostics,
    log.errors.length,
  );
}

// ---------------------------------------------------------------------------
// [case 2] Positive control — guarded phases continue after sync throw
// ---------------------------------------------------------------------------
console.log("\n[case 2] positive control — sync server.close throw continues cleanup");
{
  const { log, phases } = createPhaseTracker({
    closeServer: () => {
      throw new Error("server close failed");
    },
  });
  await runTelegramWebhookShutdownPhases(phases);
  assert("abort + drain + closeServer ran", () => {
    return log.abort === 1 && log.drain === 1 && log.closeServer === 1;
  });
  assert("stopBot still ran", () => log.stopBot === 1);
  assert("closeTransport still ran", () => log.closeTransport === 1);
  assert("noteStop still ran", () => log.noteStop === 1);
  assert("stopDiagnostics still ran", () => log.stopDiagnostics === 1);
  assert("server close failure was logged", () =>
    log.errors.some((e) => e.includes("webhook server close failed")),
  );
  assert("shutdown promise did not reject", () => true);
  console.log(
    "  info: stopBot=%d closeTransport=%d noteStop=%d stopDiagnostics=%d errors=%j",
    log.stopBot,
    log.closeTransport,
    log.noteStop,
    log.stopDiagnostics,
    log.errors,
  );
}

// ---------------------------------------------------------------------------
// [case 3] Valid path — clean close still runs full ordered teardown
// ---------------------------------------------------------------------------
console.log("\n[case 3] valid path — clean server.close runs full teardown");
{
  const { log, phases } = createPhaseTracker({
    closeServer: () => undefined,
  });
  await runTelegramWebhookShutdownPhases(phases);
  assert("every phase ran exactly once", () => {
    return (
      log.abort === 1 &&
      log.drain === 1 &&
      log.closeServer === 1 &&
      log.stopBot === 1 &&
      log.closeTransport === 1 &&
      log.noteStop === 1 &&
      log.stopDiagnostics === 1
    );
  });
  assert("no errors logged on clean path", () => log.errors.length === 0);
  console.log("  info: phases_ok=true errors=%d", log.errors.length);
}

console.log("\n=== Summary ===");
console.log("ALL PROOF ASSERTIONS: %d passed, %d failed", passed, failed);
if (failed > 0) {
  process.exit(1);
}
