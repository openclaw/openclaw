import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, afterEach } from "vitest";
import { AuditLog } from "../src/governance/audit-log.js";
import { BudgetLedger } from "../src/governance/budget-ledger.js";
import { createGovernanceTools } from "../src/governance/tools.js";

let cleanupDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "gov-tools-test-"));
  cleanupDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of cleanupDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
  cleanupDirs = [];
});

describe("Governance Tools", () => {
  it("registers budget_status tool", () => {
    const dir = makeTempDir();
    const ledger = new BudgetLedger(join(dir, "budget.db"));
    const audit = new AuditLog(join(dir, "audit.db"));
    const tools = createGovernanceTools(ledger, audit);

    const tool = tools.find((t) => t.name === "budget_status");
    expect(tool).toBeDefined();
    expect(tool!.label).toBe("Budget Status");

    ledger.close();
    audit.close();
  });

  it("registers budget_request tool", () => {
    const dir = makeTempDir();
    const ledger = new BudgetLedger(join(dir, "budget.db"));
    const audit = new AuditLog(join(dir, "audit.db"));
    const tools = createGovernanceTools(ledger, audit);

    const tool = tools.find((t) => t.name === "budget_request");
    expect(tool).toBeDefined();
    expect(tool!.label).toBe("Budget Request");

    ledger.close();
    audit.close();
  });

  it("registers audit_query tool", () => {
    const dir = makeTempDir();
    const ledger = new BudgetLedger(join(dir, "budget.db"));
    const audit = new AuditLog(join(dir, "audit.db"));
    const tools = createGovernanceTools(ledger, audit);

    const tool = tools.find((t) => t.name === "audit_query");
    expect(tool).toBeDefined();
    expect(tool!.label).toBe("Audit Query");

    ledger.close();
    audit.close();
  });

  it("budget_status returns agent budget with allocation", async () => {
    const dir = makeTempDir();
    const ledger = new BudgetLedger(join(dir, "budget.db"));
    const audit = new AuditLog(join(dir, "audit.db"));

    // Create an allocation of $50 for today
    const now = new Date();
    const dailyKey = now.toISOString().slice(0, 10);
    ledger.ensureAllocation("default", "agent-1", "daily", dailyKey, 50);

    const tools = createGovernanceTools(ledger, audit);
    const tool = tools.find((t) => t.name === "budget_status")!;

    const result = await tool.execute({ agent_id: "agent-1" });
    const text = result.content[0].text;

    expect(text).toContain("50");
    expect(text).toContain("agent-1");
    expect(text).toContain("Can Spend: Yes");

    ledger.close();
    audit.close();
  });
});
