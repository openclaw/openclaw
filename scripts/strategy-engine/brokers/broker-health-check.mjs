#!/usr/bin/env node
/**
 * broker-health-check.mjs — 所有券商 adapter 健康檢查
 * 用法: node scripts/strategy-engine/brokers/broker-health-check.mjs [--json]
 */
import { CapitalAdapter } from "./CapitalAdapter.mjs";
import { OkxAdapter } from "./OkxAdapter.mjs";

const adapters = [new CapitalAdapter({ mode: "paper" }), new OkxAdapter({ mode: "demo" })];

const results = [];
for (const adapter of adapters) {
  const healthy = await adapter.isHealthy();
  const info = { ...adapter.toJSON(), healthy };
  results.push(info);
  if (!process.argv.includes("--json")) {
    const icon = healthy ? "✅" : "❌";
    console.log(
      `${icon} ${adapter.displayName} [${adapter.mode}] — ${healthy ? "健康" : "不可用"}`,
    );
  }
}

if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ brokers: results, checkedAt: new Date().toISOString() }, null, 2));
}
