import { Command } from "commander";
import { expect, it, vi } from "vitest";
import type { AuditRow } from "./broker.js";
import { registerOnePasswordCommands } from "./cli.js";
import { parseOnePasswordConfig } from "./config.js";
import { MemoryKeyedStore } from "./memory-store.test-support.js";

const config = parseOnePasswordConfig({
  vault: "Automation",
  items: {
    alpha: { item: "Sensitive title", policy: "auto" },
    beta: { item: "Other" },
    gamma: { item: "Third", policy: "deny" },
  },
});

async function setupCommands(...rows: Partial<AuditRow>[]) {
  const auditStore = new MemoryKeyedStore<AuditRow>();
  for (const [index, row] of rows.entries()) {
    await auditStore.register(String(index), {
      timestampMs: (index + 1) * 1000,
      agentId: "agent-a",
      sessionKey: "session-a",
      toolCallId: "call-a",
      slug: "alpha",
      reason: "short",
      outcome: "auto",
      ...row,
    });
  }
  const program = new Command().exitOverride();
  const write = vi.fn<(message: string) => void>();
  registerOnePasswordCommands({
    program,
    auditStore,
    write,
    resolveConfig: () => config,
    resolveOpClient: () => ({ opBin: "/usr/local/bin/op", tokenFilePresent: async () => true }),
  });
  return {
    auditStore,
    write,
    async run<T = unknown>(this: void, ...args: string[]): Promise<T> {
      await program.parseAsync(["onepassword", ...args], { from: "user" });
      return JSON.parse(String(write.mock.calls[0]?.[0])) as T;
    },
  };
}

it("status contains readiness and counts without token or item values", async () => {
  const { run } = await setupCommands();
  expect(await run("status")).toEqual({
    tokenFilePresent: true,
    opBinaryResolved: true,
    opBinaryPath: "/usr/local/bin/op",
    itemCount: 3,
    policyCounts: { auto: 1, approve: 1, deny: 1 },
  });
});

it("audit output is deterministic, limited, truncated, and value-free", async () => {
  const { run } = await setupCommands(
    {},
    {
      agentId: "agent-b",
      slug: "beta",
      reason: `prefix-${"x".repeat(100)}`,
      outcome: "approved",
    },
  );
  const rows = await run("audit", "--limit", "1");
  expect(rows).toEqual([
    {
      timestamp: "1970-01-01T00:00:02.000Z",
      agent: "agent-b",
      slug: "beta",
      outcome: "approved",
      reason: `prefix-${"x".repeat(70)}...`,
    },
  ]);
});

it("preserves complete surrogate pairs at the audit reason boundary", async () => {
  const { run, write } = await setupCommands(
    { reason: `${"x".repeat(76)}\u{1f600}tail` },
    { reason: `${"x".repeat(75)}\u{1f600}tail` },
  );
  const rows = await run<Array<{ reason: string }>>("audit", "--limit", "2");
  expect(String(write.mock.calls[0]?.[0])).not.toContain("\\ud83d");
  expect(rows.map((row) => row.reason)).toEqual([
    `${"x".repeat(75)}\u{1f600}...`,
    `${"x".repeat(76)}...`,
  ]);
});

it.each(["0", "1.5", "1e3", "1001"])("rejects invalid audit limits: %j", async (limit) => {
  const { run, write, auditStore } = await setupCommands();
  const entries = vi.spyOn(auditStore, "entries");
  await expect(run("audit", "--limit", limit)).rejects.toThrow(
    "--limit must be an integer from 1 to 1000",
  );
  expect([entries.mock.calls, write.mock.calls]).toEqual([[], []]);
});

it("accepts the maximum decimal audit limit", async () => {
  const { run } = await setupCommands();
  expect(await run("audit", "--limit", "1000")).toEqual([]);
});
