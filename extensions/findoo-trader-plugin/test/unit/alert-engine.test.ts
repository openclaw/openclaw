import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AlertEngine } from "../../src/core/alert-engine.js";

describe("AlertEngine", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = join(tmpdir(), `alert-engine-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    dbPath = join(dir, "alerts.sqlite");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("should add and list alerts", () => {
    const engine = new AlertEngine(dbPath);
    const id = engine.addAlert(
      { kind: "price_above", symbol: "BTC/USDT", price: 50000 },
      "BTC moon",
    );
    expect(id).toBeTruthy();

    const alerts = engine.listAlerts();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.id).toBe(id);
    expect(alerts[0]!.condition).toEqual({ kind: "price_above", symbol: "BTC/USDT", price: 50000 });
    expect(alerts[0]!.message).toBe("BTC moon");
    expect(alerts[0]!.notified).toBe(false);
    expect(alerts[0]!.createdAt).toBeTruthy();
    expect(alerts[0]!.triggeredAt).toBeUndefined();
    engine.close();
  });

  it("should remove an alert by id", () => {
    const engine = new AlertEngine(dbPath);
    const id = engine.addAlert({ kind: "drawdown", threshold: -0.1 });
    expect(engine.removeAlert(id)).toBe(true);
    expect(engine.listAlerts()).toHaveLength(0);
    engine.close();
  });

  it("should return false when removing non-existent id", () => {
    const engine = new AlertEngine(dbPath);
    expect(engine.removeAlert("does-not-exist")).toBe(false);
    engine.close();
  });

  it("should persist data across close/reopen", () => {
    const engine1 = new AlertEngine(dbPath);
    engine1.addAlert({ kind: "volume_spike", symbol: "ETH/USDT" }, "volume alert");
    engine1.addAlert({ kind: "price_below", symbol: "SOL/USDT", price: 20 });
    engine1.close();

    const engine2 = new AlertEngine(dbPath);
    const alerts = engine2.listAlerts();
    expect(alerts).toHaveLength(2);
    expect(alerts.map((a) => a.condition.kind)).toContain("volume_spike");
    expect(alerts.map((a) => a.condition.kind)).toContain("price_below");
    engine2.close();
  });

  it("should add alert without message", () => {
    const engine = new AlertEngine(dbPath);
    engine.addAlert({ kind: "price_above", symbol: "BTC/USDT", price: 100000 });
    const alerts = engine.listAlerts();
    expect(alerts[0]!.message).toBeUndefined();
    engine.close();
  });

  it("should trigger an alert", () => {
    const engine = new AlertEngine(dbPath);
    const id = engine.addAlert({ kind: "price_above", symbol: "BTC/USDT", price: 50000 });
    expect(engine.triggerAlert(id)).toBe(true);

    const alerts = engine.listAlerts();
    expect(alerts[0]!.triggeredAt).toBeTruthy();
    expect(alerts[0]!.notified).toBe(true);
    engine.close();
  });

  it("should return false when triggering non-existent alert", () => {
    const engine = new AlertEngine(dbPath);
    expect(engine.triggerAlert("ghost-id")).toBe(false);
    engine.close();
  });

  it("should handle multiple alerts and selective removal", () => {
    const engine = new AlertEngine(dbPath);
    const id1 = engine.addAlert({ kind: "price_above", price: 100 });
    const id2 = engine.addAlert({ kind: "price_below", price: 50 });
    const id3 = engine.addAlert({ kind: "drawdown", threshold: -0.2 });

    engine.removeAlert(id2);
    const alerts = engine.listAlerts();
    expect(alerts).toHaveLength(2);
    expect(alerts.map((a) => a.id)).toContain(id1);
    expect(alerts.map((a) => a.id)).toContain(id3);
    expect(alerts.map((a) => a.id)).not.toContain(id2);
    engine.close();
  });
});
