import { finished } from "node:stream/promises";
import { afterEach, expect, vi } from "vitest";
import { createClientHarness } from "./test-support.js";

export function useClientHarnesses(drainOutput = false) {
  const harnesses: ReturnType<typeof createClientHarness>[] = [];
  afterEach(async () => {
    for (const harness of harnesses.splice(0)) {
      if (drainOutput) {
        const outputs = [harness.process.stdout, harness.process.stderr];
        const drained = Promise.all(outputs.map((output) => finished(output, { cleanup: true })));
        for (const output of outputs) {
          output.end();
          output.resume();
        }
        await drained;
      } else {
        harness.client.close();
      }
      harness.emitExit();
      await expect(harness.client.closeAndWait()).resolves.toMatchObject({ exited: true });
    }
    vi.restoreAllMocks();
    vi.useRealTimers();
  });
  return (options: Parameters<typeof createClientHarness>[0] = {}) => {
    const harness = createClientHarness({ autoEmitExit: false, ...options });
    harnesses.push(harness);
    return harness;
  };
}
