import { describe, expect, it } from "vitest";
import type { AuditRow } from "./broker.js";
import { buildStatus, readAuditRows } from "./cli.js";
import type { OnePasswordConfig } from "./config.js";
import { MemoryKeyedStore } from "./memory-store.test-support.js";

const config: OnePasswordConfig = {
  vault: "Automation",
  defaultPolicy: "approve",
  cacheTtlSeconds: 300,
  grantTtlHours: 720,
  opTimeoutMs: 15_000,
  items: {
    alpha: { item: "Sensitive title", vault: "Automation", field: "credential", policy: "auto" },
    beta: { item: "Other", vault: "Automation", field: "credential", policy: "approve" },
    gamma: { item: "Third", vault: "Automation", field: "credential", policy: "deny" },
  },
};

describe("1Password CLI output", () => {
  it("status contains readiness and counts without token or item values", async () => {
    const status = await buildStatus(config, {
      opBin: "/usr/local/bin/op",
      tokenFilePresent: async () => true,
    });
    expect(status).toEqual({
      tokenFilePresent: true,
      opBinaryResolved: true,
      opBinaryPath: "/usr/local/bin/op",
      itemCount: 3,
      policyCounts: { auto: 1, approve: 1, deny: 1 },
    });
    expect(JSON.stringify(status)).not.toContain("Sensitive title");
  });

  it("audit output is deterministic, limited, truncated, and value-free", async () => {
    const store = new MemoryKeyedStore<AuditRow>();
    await store.register("first", {
      timestampMs: 1000,
      agentId: "agent-a",
      sessionKey: "session-a",
      toolCallId: "call-a",
      slug: "alpha",
      reason: "short",
      outcome: "auto",
    });
    await store.register("second", {
      timestampMs: 2000,
      agentId: "agent-b",
      sessionKey: "session-b",
      toolCallId: "call-b",
      slug: "beta",
      reason: `prefix-${"x".repeat(100)}`,
      outcome: "approved",
    });
    const rows = await readAuditRows(store, 1);
    expect(rows).toEqual([
      {
        timestamp: "1970-01-01T00:00:02.000Z",
        agent: "agent-b",
        slug: "beta",
        outcome: "approved",
        reason: expect.stringMatching(/^prefix-.+\.\.\.$/),
      },
    ]);
    expect(rows[0]?.reason).toHaveLength(80);
    expect(JSON.stringify(rows)).not.toContain(["fixture", "value"].join("-"));
  });
});
