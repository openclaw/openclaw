import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import saintOrchestratorPlugin, { __testing } from "../index.js";
import { getBudgetSpent, utcDayPrefix } from "./budget.js";

type HookHandler = (
  event: Record<string, unknown>,
  ctx: Record<string, unknown>,
) => Promise<unknown>;

function registerHooks(): Map<string, HookHandler> {
  const handlers = new Map<string, HookHandler>();
  saintOrchestratorPlugin.register({
    registerService: () => undefined,
    on: (name: string, handler: HookHandler) => {
      handlers.set(name, handler);
    },
    registerHook: () => undefined,
    registerTool: () => undefined,
  } as never);
  return handlers;
}

async function createWorkspace(prefix: string): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function readUsageEntries(workspaceDir: string): Promise<Array<Record<string, unknown>>> {
  const filePath = path.join(workspaceDir, "logs", "usage.jsonl");
  const raw = await fs.readFile(filePath, "utf-8");
  return raw
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("after_tool_call budget fallback accounting", () => {
  it("does not bill errored calls when no reservation exists", async () => {
    const workspaceDir = await createWorkspace("saint-index-budget-error-");
    try {
      const handlers = registerHooks();
      const afterToolCall = handlers.get("after_tool_call");
      if (!afterToolCall) {
        throw new Error("after_tool_call handler is not registered");
      }
      const ctx = {
        workspaceDir,
        sessionKey: "agent:main:direct:client@example.com",
        messageProvider: "email",
        peerId: "client@example.com",
      };

      await afterToolCall(
        {
          toolName: "exec",
          params: { command: "rm -rf /tmp/demo" },
          error: "Tool call blocked by plugin hook",
          durationMs: 1,
        },
        ctx,
      );

      const slug = __testing.resolveExternalSlug({
        messageProvider: "email",
        peerId: "client@example.com",
      });
      const spent = await getBudgetSpent(workspaceDir, slug, utcDayPrefix());
      expect(spent).toBe(0);

      const usage = await readUsageEntries(workspaceDir);
      expect(usage).toHaveLength(1);
      expect(usage[0]?.estimatedCostUsd).toBe(0);
      expect(usage[0]?.error).toBe("Tool call blocked by plugin hook");
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("bills successful calls when no reservation exists", async () => {
    const workspaceDir = await createWorkspace("saint-index-budget-success-");
    try {
      const handlers = registerHooks();
      const afterToolCall = handlers.get("after_tool_call");
      if (!afterToolCall) {
        throw new Error("after_tool_call handler is not registered");
      }
      const ctx = {
        workspaceDir,
        sessionKey: "agent:main:direct:client@example.com",
        messageProvider: "email",
        peerId: "client@example.com",
      };

      await afterToolCall(
        {
          toolName: "web_search",
          params: { query: "openclaw" },
          durationMs: 1,
        },
        ctx,
      );

      const slug = __testing.resolveExternalSlug({
        messageProvider: "email",
        peerId: "client@example.com",
      });
      const spent = await getBudgetSpent(workspaceDir, slug, utcDayPrefix());
      expect(spent).toBeCloseTo(0.004, 6);

      const usage = await readUsageEntries(workspaceDir);
      expect(usage).toHaveLength(1);
      expect(Number(usage[0]?.estimatedCostUsd)).toBeCloseTo(0.004, 6);
      expect(usage[0]?.error).toBeUndefined();
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });
});
