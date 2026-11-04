import { channel } from "node:diagnostics_channel";

const probe = channel("openclaw.clawrouter.fixture-phase");

export function recordProviderFixturePhase(phase: string) {
  if (probe.hasSubscribers) {
    probe.publish({ phase, wallMs: Date.now(), monotonicMs: performance.now() });
  }
}

/** Temporary failure attribution only: real clocks, fixed phase names, numeric facts. */
export function captureProviderPhases(name: string, run: () => Promise<void>) {
  return async () => {
    const rows: Array<Record<string, string | number | null>> = [];
    const listener = (message: unknown) => {
      if (!message || typeof message !== "object" || rows.length >= 128) {
        return;
      }
      const row: Record<string, string | number | null> = {};
      for (const [key, value] of Object.entries(message)) {
        if (key === "phase" && typeof value === "string") {
          row.phase = value;
        } else if (typeof value === "number" || value === null) {
          row[key] = value;
        }
      }
      rows.push(row);
    };
    probe.subscribe(listener);
    recordProviderFixturePhase("fixture:start");
    try {
      await run();
    } finally {
      recordProviderFixturePhase("fixture:end");
      probe.unsubscribe(listener);
      console.info("CLAWROUTER_PHASE_CAPTURE " + JSON.stringify({ name, rows }));
    }
  };
}
