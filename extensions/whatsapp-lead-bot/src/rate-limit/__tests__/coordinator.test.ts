import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach } from "vitest";
import { SqliteDatabase } from "../../database/connection.js";
import { CircuitBreaker, type CircuitBreakerNotifier } from "../circuit-breaker.js";
import { RateLimitCoordinator } from "../coordinator.js";
import { GlobalRateLimiter } from "../global-limiter.js";
import { RateLimiter } from "../limiter.js";

function tmpDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "leadbot-test-"));
  return path.join(dir, "test.db");
}

class FakeNotifier implements CircuitBreakerNotifier {
  tripped: string[] = [];
  resets = 0;
  async notifyCircuitTripped(reason: string) {
    this.tripped.push(reason);
  }
  async notifyCircuitReset() {
    this.resets++;
  }
}

async function setup(overrides?: {
  perLeadMax?: number;
  globalMax?: number;
  cbThreshold?: number;
  cbMinChecks?: number;
  cbWindowMs?: number;
}) {
  const dbPath = tmpDb();
  const db = new SqliteDatabase({ dbPath });
  await db.migrate();

  const notifier = new FakeNotifier();

  const rateLimiter = new RateLimiter(db, {
    enabled: true,
    messagesPerHour: overrides?.perLeadMax ?? 10,
    windowMs: 3600000,
  });

  const globalLimiter = new GlobalRateLimiter(db, {
    enabled: true,
    maxMessagesPerHour: overrides?.globalMax ?? 1000,
    windowMs: 3600000,
  });

  const circuitBreaker = new CircuitBreaker(
    db,
    {
      enabled: true,
      hitRateThreshold: overrides?.cbThreshold ?? 0.8,
      windowMs: overrides?.cbWindowMs ?? 300000,
      minChecks: overrides?.cbMinChecks ?? 10,
    },
    notifier,
  );

  const coordinator = new RateLimitCoordinator(circuitBreaker, globalLimiter, rateLimiter);

  // Create a test lead
  const lead = await db.getOrCreateLead("+15551234567");

  return { db, rateLimiter, globalLimiter, circuitBreaker, coordinator, notifier, lead };
}

describe("Per-lead atomic rate limit", () => {
  it("allows messages under the limit", async () => {
    const { db, lead } = await setup({ perLeadMax: 5 });
    const result = await db.checkAndRecordMessage(lead.id, 5, 3600000);
    expect(result.allowed).toBe(true);
    expect(result.count).toBe(1);
  });

  it("denies after exceeding per-lead limit", async () => {
    const { db, lead } = await setup({ perLeadMax: 3 });

    for (let i = 0; i < 3; i++) {
      const r = await db.checkAndRecordMessage(lead.id, 3, 3600000);
      expect(r.allowed).toBe(true);
    }

    const denied = await db.checkAndRecordMessage(lead.id, 3, 3600000);
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toContain("Rate limit exceeded");
  });

  it("resets after window expires", async () => {
    const { db, lead } = await setup({ perLeadMax: 2 });

    // Fill up with a long window
    await db.checkAndRecordMessage(lead.id, 2, 3600000);
    await db.checkAndRecordMessage(lead.id, 2, 3600000);

    // Simulate window expiry by backdating window_start
    const pastStart = Date.now() - 3600001;
    await db.updateRateLimitWindow(lead.id, pastStart);

    const result = await db.checkAndRecordMessage(lead.id, 2, 3600000);
    expect(result.allowed).toBe(true);
    expect(result.count).toBe(1);
  });
});

describe("Global rate limiter", () => {
  it("allows under global limit", async () => {
    const { globalLimiter } = await setup({ globalMax: 100 });
    const result = await globalLimiter.check();
    expect(result.allowed).toBe(true);
  });

  it("denies after exceeding global limit", async () => {
    const { globalLimiter } = await setup({ globalMax: 3 });

    await globalLimiter.record();
    await globalLimiter.record();
    await globalLimiter.record();

    const result = await globalLimiter.check();
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("Global rate limit exceeded");
  });

  it("getStatus returns current counts", async () => {
    const { globalLimiter } = await setup({ globalMax: 50 });
    await globalLimiter.record();
    await globalLimiter.record();

    const status = await globalLimiter.getStatus();
    expect(status.count).toBe(2);
    expect(status.maxPerHour).toBe(50);
  });
});

describe("Circuit breaker", () => {
  it("stays open when hit rate is below threshold", async () => {
    const { circuitBreaker, notifier } = await setup({
      cbThreshold: 0.8,
      cbMinChecks: 5,
    });

    // 4 passes, 1 hit = 20% hit rate
    for (let i = 0; i < 4; i++) {
      await circuitBreaker.recordCheck(false);
    }
    await circuitBreaker.recordCheck(true);

    const result = await circuitBreaker.check();
    expect(result.allowed).toBe(true);
    expect(notifier.tripped.length).toBe(0);
  });

  it("trips when hit rate exceeds threshold", async () => {
    const { circuitBreaker, notifier } = await setup({
      cbThreshold: 0.8,
      cbMinChecks: 5,
    });

    // 5 hits out of 5 = 100% hit rate
    for (let i = 0; i < 5; i++) {
      await circuitBreaker.recordCheck(true);
    }

    const result = await circuitBreaker.check();
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("Circuit breaker tripped");
    expect(notifier.tripped.length).toBe(1);
  });

  it("does not trip below minChecks", async () => {
    const { circuitBreaker, notifier } = await setup({
      cbThreshold: 0.8,
      cbMinChecks: 10,
    });

    // 5 hits but minChecks=10 → shouldn't trip
    for (let i = 0; i < 5; i++) {
      await circuitBreaker.recordCheck(true);
    }

    const result = await circuitBreaker.check();
    expect(result.allowed).toBe(true);
    expect(notifier.tripped.length).toBe(0);
  });

  it("can be reset by admin", async () => {
    const { circuitBreaker, notifier } = await setup({
      cbThreshold: 0.8,
      cbMinChecks: 5,
    });

    // Trip it
    for (let i = 0; i < 5; i++) {
      await circuitBreaker.recordCheck(true);
    }
    expect((await circuitBreaker.check()).allowed).toBe(false);

    // Reset
    await circuitBreaker.reset();
    expect(notifier.resets).toBe(1);

    const result = await circuitBreaker.check();
    expect(result.allowed).toBe(true);
  });

  it("getStatus reflects current state", async () => {
    const { circuitBreaker } = await setup({
      cbThreshold: 0.8,
      cbMinChecks: 5,
    });

    await circuitBreaker.recordCheck(true);
    await circuitBreaker.recordCheck(false);

    const status = await circuitBreaker.getStatus();
    expect(status.isTripped).toBe(false);
    expect(status.totalChecks).toBe(2);
    expect(status.totalHits).toBe(1);
    expect(status.hitRate).toBe(0.5);
  });
});

describe("RateLimitCoordinator (3-layer)", () => {
  it("allows message when all layers pass", async () => {
    const { coordinator, lead } = await setup();
    const result = await coordinator.checkAndRecord(lead.id);
    expect(result.allowed).toBe(true);
    expect(result.layer).toBeUndefined();
  });

  it("denies at circuit breaker layer", async () => {
    const { coordinator, circuitBreaker, lead } = await setup({
      cbThreshold: 0.8,
      cbMinChecks: 5,
    });

    // Trip the breaker manually
    for (let i = 0; i < 5; i++) {
      await circuitBreaker.recordCheck(true);
    }

    const result = await coordinator.checkAndRecord(lead.id);
    expect(result.allowed).toBe(false);
    expect(result.layer).toBe("circuit_breaker");
  });

  it("denies at global layer", async () => {
    const { coordinator, globalLimiter, lead } = await setup({ globalMax: 2 });

    // Fill up global limit
    await globalLimiter.record();
    await globalLimiter.record();

    const result = await coordinator.checkAndRecord(lead.id);
    expect(result.allowed).toBe(false);
    expect(result.layer).toBe("global");
  });

  it("denies at per-lead layer", async () => {
    const { coordinator, lead } = await setup({ perLeadMax: 2 });

    // Use up per-lead limit
    await coordinator.checkAndRecord(lead.id);
    await coordinator.checkAndRecord(lead.id);

    const result = await coordinator.checkAndRecord(lead.id);
    expect(result.allowed).toBe(false);
    expect(result.layer).toBe("per_lead");
  });

  it("circuit breaker trips after sustained per-lead denials", async () => {
    const { coordinator, circuitBreaker, db } = await setup({
      perLeadMax: 1,
      cbThreshold: 0.8,
      cbMinChecks: 5,
    });

    // Create multiple leads that each exhaust their per-lead limit
    const leads = [];
    for (let i = 0; i < 10; i++) {
      leads.push(await db.getOrCreateLead(`+1555000${i.toString().padStart(4, "0")}`));
    }

    // First message for each lead → allowed (5 passes)
    for (let i = 0; i < 5; i++) {
      const r = await coordinator.checkAndRecord(leads[i].id);
      expect(r.allowed).toBe(true);
    }

    // Second message for same leads → denied (5 hits)
    for (let i = 0; i < 5; i++) {
      await coordinator.checkAndRecord(leads[i].id);
    }

    // After 10 checks with 5 hits (50%), still not tripped
    const status = await circuitBreaker.getStatus();
    expect(status.isTripped).toBe(false);
  });

  it("increments global counter on allowed messages", async () => {
    const { coordinator, globalLimiter, lead } = await setup();

    await coordinator.checkAndRecord(lead.id);
    await coordinator.checkAndRecord(lead.id);

    const status = await globalLimiter.getStatus();
    expect(status.count).toBe(2);
  });
});
