import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BudgetLedger } from "../src/governance/budget-ledger.js";
import { BudgetExhaustedError } from "../src/governance/types.js";

function tempDb(): string {
  return join(tmpdir(), `budget-test-${randomUUID()}.sqlite`);
}

describe("BudgetLedger", () => {
  const dbs: string[] = [];
  const ledgers: BudgetLedger[] = [];

  function createLedger(): BudgetLedger {
    const path = tempDb();
    dbs.push(path);
    const ledger = new BudgetLedger(path);
    ledgers.push(ledger);
    return ledger;
  }

  afterEach(() => {
    for (const l of ledgers) {
      try {
        l.close();
      } catch {
        // already closed
      }
    }
    ledgers.length = 0;
    for (const p of dbs) {
      try {
        unlinkSync(p);
      } catch {
        // ok
      }
      try {
        unlinkSync(p + "-wal");
      } catch {
        // ok
      }
      try {
        unlinkSync(p + "-shm");
      } catch {
        // ok
      }
    }
    dbs.length = 0;
  });

  it("creates allocation and tracks budget", () => {
    const ledger = createLedger();
    const alloc = ledger.ensureAllocation("co1", "agent-1", "daily", "2026-03-29", 50);

    expect(alloc.companyId).toBe("co1");
    expect(alloc.agentId).toBe("agent-1");
    expect(alloc.periodType).toBe("daily");
    expect(alloc.limitUsd).toBe(50);
    expect(alloc.spentUsd).toBe(0);
    expect(alloc.reservedUsd).toBe(0);

    // Updating limit via ensureAllocation
    const updated = ledger.ensureAllocation("co1", "agent-1", "daily", "2026-03-29", 100);
    expect(updated.limitUsd).toBe(100);
  });

  it("reserves and settles budget atomically", () => {
    const ledger = createLedger();
    ledger.ensureAllocation("co1", "agent-1", "daily", "2026-03-29", 50);

    const resId = ledger.reserveBudget({
      companyId: "co1",
      agentId: "agent-1",
      estimatedCostUsd: 10,
      sessionId: "sess-1",
    });

    expect(resId).toMatch(/^ce-/);

    // During reservation: reserved should be 10, spent 0
    const statusDuring = ledger.getBudgetStatus("co1", "agent-1");
    // getBudgetStatus uses current date key, but we set a specific key,
    // so query the allocation directly for the test
    // Instead, let's use today's key for a cleaner test
    const ledger2 = createLedger();
    const today = new Date().toISOString().slice(0, 10);
    ledger2.ensureAllocation("co1", "agent-1", "daily", today, 50);

    const resId2 = ledger2.reserveBudget({
      companyId: "co1",
      agentId: "agent-1",
      estimatedCostUsd: 10,
    });

    const midStatus = ledger2.getBudgetStatus("co1", "agent-1");
    expect(midStatus.daily!.reserved).toBe(10);
    expect(midStatus.daily!.spent).toBe(0);
    expect(midStatus.daily!.remaining).toBe(40);

    // Settle with actual cost
    ledger2.settleReservation(resId2, 8);

    const afterStatus = ledger2.getBudgetStatus("co1", "agent-1");
    expect(afterStatus.daily!.reserved).toBe(0);
    expect(afterStatus.daily!.spent).toBe(8);
    expect(afterStatus.daily!.remaining).toBe(42);
  });

  it("throws BudgetExhaustedError when over limit", () => {
    const ledger = createLedger();
    const today = new Date().toISOString().slice(0, 10);
    ledger.ensureAllocation("co1", "agent-1", "daily", today, 20);

    // First reservation succeeds
    ledger.reserveBudget({
      companyId: "co1",
      agentId: "agent-1",
      estimatedCostUsd: 15,
    });

    // Second reservation exceeds limit
    expect(() =>
      ledger.reserveBudget({
        companyId: "co1",
        agentId: "agent-1",
        estimatedCostUsd: 10,
      }),
    ).toThrow(BudgetExhaustedError);
  });

  it("releases reservation when task cancelled", () => {
    const ledger = createLedger();
    const today = new Date().toISOString().slice(0, 10);
    ledger.ensureAllocation("co1", "agent-1", "daily", today, 50);

    const resId = ledger.reserveBudget({
      companyId: "co1",
      agentId: "agent-1",
      estimatedCostUsd: 30,
    });

    // Reserved should be 30
    const midStatus = ledger.getBudgetStatus("co1", "agent-1");
    expect(midStatus.daily!.reserved).toBe(30);

    // Release
    ledger.releaseReservation(resId);

    const afterStatus = ledger.getBudgetStatus("co1", "agent-1");
    expect(afterStatus.daily!.reserved).toBe(0);
    expect(afterStatus.daily!.spent).toBe(0);
    expect(afterStatus.daily!.remaining).toBe(50);
  });

  it("records direct cost events", () => {
    const ledger = createLedger();
    const today = new Date().toISOString().slice(0, 10);
    ledger.ensureAllocation("co1", "agent-1", "daily", today, 100);

    const eventId = ledger.recordDirectCost({
      companyId: "co1",
      agentId: "agent-1",
      eventType: "llm_input",
      amountUsd: 0.05,
      model: "claude-3-haiku",
      inputTokens: 1000,
    });

    expect(eventId).toMatch(/^ce-/);

    const status = ledger.getBudgetStatus("co1", "agent-1");
    expect(status.daily!.spent).toBe(0.05);
    expect(status.daily!.remaining).toBeCloseTo(99.95);
  });
});
