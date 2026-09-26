import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import type { AuditRow } from "./broker.js";
import { registerOnePasswordCommands } from "./cli.js";
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

function setupCommands(auditStore = new MemoryKeyedStore<AuditRow>()) {
  const program = new Command().exitOverride();
  const write = vi.fn<(message: string) => void>();
  registerOnePasswordCommands({
    program,
    resolveConfig: () => config,
    resolveOpClient: () => ({
      opBin: "/usr/local/bin/op",
      tokenFilePresent: async () => true,
    }),
    auditStore,
    write,
  });
  return {
    run: (...args: string[]) => program.parseAsync(["onepassword", ...args], { from: "user" }),
    write,
  };
}

describe("1Password CLI output", () => {
  it("status contains readiness and counts without token or item values", async () => {
    const { run, write } = setupCommands();
    await run("status");
    const status = JSON.parse(String(write.mock.calls[0]?.[0])) as Record<string, unknown>;

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
    const { run, write } = setupCommands(store);
    await run("audit", "--limit", "1");
    const rows = JSON.parse(String(write.mock.calls[0]?.[0])) as Array<Record<string, unknown>>;

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
  });

  it("preserves complete surrogate pairs at the audit reason boundary", async () => {
    const store = new MemoryKeyedStore<AuditRow>();
    await store.register("split", {
      timestampMs: 1000,
      agentId: "agent-a",
      sessionKey: "session-a",
      toolCallId: "call-a",
      slug: "alpha",
      reason: `${"x".repeat(76)}\u{1f600}tail`,
      outcome: "auto",
    });
    await store.register("fits", {
      timestampMs: 2000,
      agentId: "agent-a",
      sessionKey: "session-a",
      toolCallId: "call-b",
      slug: "alpha",
      reason: `${"x".repeat(75)}\u{1f600}tail`,
      outcome: "auto",
    });
    const { run, write } = setupCommands(store);

    await run("audit", "--limit", "2");
    const output = String(write.mock.calls[0]?.[0]);
    expect(output).not.toContain("\\ud83d");
    const rows = JSON.parse(output) as Array<Record<string, unknown>>;

    expect(rows.map((row) => row.reason)).toEqual([
      `${"x".repeat(75)}\u{1f600}...`,
      `${"x".repeat(76)}...`,
    ]);
  });

  it.each(["0", "1.5", "1e3", "1001"])("rejects invalid audit limits: %j", async (limit) => {
    const store = new MemoryKeyedStore<AuditRow>();
    const entries = vi.spyOn(store, "entries");
    const { run, write } = setupCommands(store);

    await expect(run("audit", "--limit", limit)).rejects.toThrow(
      "--limit must be an integer from 1 to 1000",
    );
    expect(entries).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it("accepts the maximum decimal audit limit", async () => {
    const { run, write } = setupCommands();

    await run("audit", "--limit", "1000");

    expect(JSON.parse(String(write.mock.calls[0]?.[0]))).toEqual([]);
  });
});
