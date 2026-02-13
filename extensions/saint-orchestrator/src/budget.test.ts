import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildBudgetReservationSignature,
  getBudgetSpent,
  getReservedBudgetSpent,
  reserveBudgetSpend,
  settleBudgetReservation,
} from "./budget.js";

async function createWorkspace(prefix: string): Promise<string> {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  await fs.mkdir(path.join(workspaceDir, "logs"), { recursive: true });
  return workspaceDir;
}

describe("budget reservation tracking", () => {
  it("tracks and settles queued reservations by signature", async () => {
    const workspaceDir = await createWorkspace("saint-budget-reserve-");
    try {
      const user = "alice";
      const day = "2026-02-13";
      const signature = buildBudgetReservationSignature({
        sessionKey: "agent:main:direct:alice",
        toolName: "web_search",
        params: { q: "hello", limit: 3 },
      });

      reserveBudgetSpend({ workspaceDir, userSlug: user, dayPrefix: day, signature, amount: 0.01 });
      reserveBudgetSpend({ workspaceDir, userSlug: user, dayPrefix: day, signature, amount: 0.02 });
      expect(getReservedBudgetSpent(workspaceDir, user, day)).toBeCloseTo(0.03, 6);

      const firstSettle = settleBudgetReservation({
        workspaceDir,
        userSlug: user,
        dayPrefix: day,
        signature,
      });
      expect(firstSettle).toBeCloseTo(0.01, 6);
      expect(getReservedBudgetSpent(workspaceDir, user, day)).toBeCloseTo(0.02, 6);
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });
});

describe("budget cold start daily usage file", () => {
  it("loads spend from usage.YYYY-MM-DD.jsonl when present", async () => {
    const workspaceDir = await createWorkspace("saint-budget-dayfile-");
    try {
      await fs.writeFile(
        path.join(workspaceDir, "logs", "usage.2026-02-13.jsonl"),
        [
          JSON.stringify({
            ts: "2026-02-13T08:00:00.000Z",
            user: "alice",
            tier: "employee",
            tool: "web_search",
            estimatedCostUsd: 0.004,
          }),
          JSON.stringify({
            ts: "2026-02-13T08:01:00.000Z",
            user: "alice",
            tier: "employee",
            tool: "web_fetch",
            estimatedCostUsd: 0.002,
          }),
          "",
        ].join("\n"),
        "utf-8",
      );

      const spent = await getBudgetSpent(workspaceDir, "alice", "2026-02-13");
      expect(spent).toBeCloseTo(0.006, 6);
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });
});
