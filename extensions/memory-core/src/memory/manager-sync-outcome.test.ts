import { describe, expect, it } from "vitest";
import { MemorySyncOutcomeLedger } from "./manager-sync-outcome.js";

describe("memory sync outcome ledger", () => {
  it("does not carry a deferred marker past a failed sync", async () => {
    const ledger = new MemorySyncOutcomeLedger();

    await expect(
      ledger.track(async () => {
        ledger.markDeferredPass();
        throw new Error("sync cleanup failed");
      }),
    ).rejects.toThrow("sync cleanup failed");
    expect(ledger.lastError).toContain("sync cleanup failed");

    await ledger.track(async () => undefined);
    expect(ledger.lastError).toBeUndefined();
  });
});
