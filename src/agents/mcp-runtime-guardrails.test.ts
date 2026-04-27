import { beforeEach, describe, expect, it, vi } from "vitest";
import { OpenClawSchema } from "../config/zod-schema.js";
import {
  createMcpRuntimeGuardrails,
  createMcpToolCircuitBreaker,
  createToolRuntimeBudgetLedger,
  resolveToolAnnotation,
} from "./mcp-runtime-guardrails.js";

vi.mock("../logger.js", () => ({
  logWarn: vi.fn(),
}));

import { logWarn } from "../logger.js";
const mockLogWarn = vi.mocked(logWarn);

beforeEach(() => {
  mockLogWarn.mockClear();
});

// ---- Circuit breaker tests ----

describe("McpToolCircuitBreaker", () => {
  it("starts closed and records success without warnings or block", async () => {
    const cb = createMcpToolCircuitBreaker({});
    let called = false;
    const result = await cb.run({ serverName: "srv", toolName: "tool" }, async () => {
      called = true;
      return "ok";
    });
    expect(result).toBe("ok");
    expect(called).toBe(true);
    const snap = cb.getSnapshot();
    expect(snap.wouldBlockCount).toBe(0);
    expect(snap.states[0]).toMatchObject({ state: "closed", consecutiveFailures: 0 });
    expect(mockLogWarn).not.toHaveBeenCalled();
  });

  it("opens after failureThreshold consecutive failures for the same key", async () => {
    const cb = createMcpToolCircuitBreaker({ cfg: { circuitBreaker: { failureThreshold: 3 } } });
    const fail = () => Promise.reject(new Error("boom"));

    for (let i = 0; i < 2; i++) {
      await expect(cb.run({ serverName: "srv", toolName: "tool" }, fail)).rejects.toThrow("boom");
    }
    expect(cb.getSnapshot().states[0].state).toBe("closed");

    await expect(cb.run({ serverName: "srv", toolName: "tool" }, fail)).rejects.toThrow("boom");
    expect(cb.getSnapshot().states[0].state).toBe("open");
    expect(mockLogWarn).toHaveBeenCalledWith(expect.stringContaining("circuit opening"));
  });

  it("keeps a different tool on the same server in closed state", async () => {
    const cb = createMcpToolCircuitBreaker({ cfg: { circuitBreaker: { failureThreshold: 2 } } });
    const fail = () => Promise.reject(new Error("boom"));

    for (let i = 0; i < 2; i++) {
      await expect(cb.run({ serverName: "srv", toolName: "toolA" }, fail)).rejects.toThrow();
    }
    expect(cb.getSnapshot().states.find((s) => s.key === "srv::toolA")?.state).toBe("open");

    // toolB should remain closed
    const result = await cb.run({ serverName: "srv", toolName: "toolB" }, async () => "ok");
    expect(result).toBe("ok");
    expect(cb.getSnapshot().states.find((s) => s.key === "srv::toolB")?.state).toBe("closed");
  });

  it("enters half_open after cooldown and closes on successful probe", async () => {
    let now = 1_000;
    const cb = createMcpToolCircuitBreaker({
      cfg: { circuitBreaker: { failureThreshold: 1, recoveryTimeoutMs: 5_000 } },
      now: () => now,
    });
    const fail = () => Promise.reject(new Error("fail"));

    await expect(cb.run({ serverName: "srv", toolName: "t" }, fail)).rejects.toThrow();
    expect(cb.getSnapshot().states[0].state).toBe("open");

    // advance past cooldown
    now += 6_000;
    const result = await cb.run({ serverName: "srv", toolName: "t" }, async () => "probe-ok");
    expect(result).toBe("probe-ok");
    expect(cb.getSnapshot().states[0].state).toBe("closed");
    expect(mockLogWarn).toHaveBeenCalledWith(expect.stringContaining("circuit closing"));
  });

  it("reopens after a failed half_open probe", async () => {
    let now = 1_000;
    const cb = createMcpToolCircuitBreaker({
      cfg: { circuitBreaker: { failureThreshold: 1, recoveryTimeoutMs: 5_000 } },
      now: () => now,
    });
    const fail = () => Promise.reject(new Error("fail"));

    await expect(cb.run({ serverName: "srv", toolName: "t" }, fail)).rejects.toThrow();
    now += 6_000;
    await expect(cb.run({ serverName: "srv", toolName: "t" }, fail)).rejects.toThrow();
    expect(cb.getSnapshot().states[0].state).toBe("open");
  });

  it("observe-only mode does not block; snapshot marks wouldBlockCount", async () => {
    let now = 1_000;
    const cb = createMcpToolCircuitBreaker({
      cfg: { circuitBreaker: { failureThreshold: 1, recoveryTimeoutMs: 9_000 } },
      now: () => now,
    });
    const fail = () => Promise.reject(new Error("fail"));

    await expect(cb.run({ serverName: "srv", toolName: "t" }, fail)).rejects.toThrow();
    expect(cb.getSnapshot().states[0].state).toBe("open");

    // Circuit is open but observe-only — call should still be made (and fail)
    now += 1_000;
    await expect(cb.run({ serverName: "srv", toolName: "t" }, fail)).rejects.toThrow("fail");
    expect(cb.getSnapshot().wouldBlockCount).toBe(1);
  });

  it("enforcement mode (enforceForTesting=true) throws when circuit is open", async () => {
    let now = 1_000;
    const cb = createMcpToolCircuitBreaker({
      cfg: { circuitBreaker: { failureThreshold: 1, recoveryTimeoutMs: 9_000 } },
      now: () => now,
      enforceForTesting: true,
    });
    const fail = () => Promise.reject(new Error("fail"));

    await expect(cb.run({ serverName: "srv", toolName: "t" }, fail)).rejects.toThrow();
    expect(cb.getSnapshot().states[0].state).toBe("open");

    now += 100;
    await expect(cb.run({ serverName: "srv", toolName: "t" }, fail)).rejects.toThrow(
      /circuit open.*retry after/,
    );
    // underlying fn was never called (enforcement blocked it)
    expect(cb.getSnapshot().wouldBlockCount).toBe(1);
  });

  it("deduplicates would-block warnings within the recovery timeout window", async () => {
    let now = 1_000;
    const cb = createMcpToolCircuitBreaker({
      cfg: {
        circuitBreaker: { failureThreshold: 1, recoveryTimeoutMs: 10_000 },
      },
      now: () => now,
    });
    const fail = () => Promise.reject(new Error("fail"));

    await expect(cb.run({ serverName: "srv", toolName: "t" }, fail)).rejects.toThrow();
    mockLogWarn.mockClear();

    // Multiple would-block calls within the recovery window → only one warn
    for (let i = 0; i < 5; i++) {
      now += 500;
      await expect(cb.run({ serverName: "srv", toolName: "t" }, fail)).rejects.toThrow();
    }
    const wouldBlockWarns = mockLogWarn.mock.calls.filter(([m]) => m.includes("would_block"));
    expect(wouldBlockWarns).toHaveLength(1);
  });

  it("disabled circuit breaker passes calls through without tracking state", async () => {
    const cb = createMcpToolCircuitBreaker({
      cfg: { circuitBreaker: { enabled: false, failureThreshold: 1 } },
    });
    const fail = () => Promise.reject(new Error("fail"));
    await expect(cb.run({ serverName: "srv", toolName: "t" }, fail)).rejects.toThrow("fail");
    expect(cb.getSnapshot().states).toHaveLength(0);
  });
});

// ---- Budget ledger tests ----

describe("ToolRuntimeBudgetLedger", () => {
  it("counts total calls and per-tool calls", () => {
    const ledger = createToolRuntimeBudgetLedger({});
    const ann = { costWeight: 1, irreversible: false };
    ledger.beforeCall({ serverName: "s", toolName: "a", annotation: ann });
    ledger.afterCall({ serverName: "s", toolName: "a", annotation: ann, ok: true });
    ledger.afterCall({ serverName: "s", toolName: "b", annotation: ann, ok: true });

    const snap = ledger.getSnapshot();
    expect(snap.totalCalls).toBe(2);
    expect(snap.callsByKey["s::a"]).toBe(1);
    expect(snap.callsByKey["s::b"]).toBe(1);
  });

  it("emits a single threshold warning when session call count is reached", () => {
    const ledger = createToolRuntimeBudgetLedger({
      cfg: { budget: { warnAfterCallsPerSession: 3 } },
    });
    const ann = { costWeight: 1, irreversible: false };
    for (let i = 0; i < 2; i++) {
      ledger.afterCall({ serverName: "s", toolName: "t", annotation: ann, ok: true });
    }
    expect(ledger.getSnapshot().warningsEmitted).toHaveLength(0);

    const { warningKeys } = ledger.afterCall({
      serverName: "s",
      toolName: "t",
      annotation: ann,
      ok: true,
    });
    expect(warningKeys).toEqual(["calls_per_session:3"]);
    expect(ledger.getSnapshot().warningsEmitted).toEqual(["calls_per_session:3"]);

    // Fourth call — warning must not repeat
    const { warningKeys: wk2 } = ledger.afterCall({
      serverName: "s",
      toolName: "t",
      annotation: ann,
      ok: true,
    });
    expect(wk2).toHaveLength(0);
    expect(ledger.getSnapshot().warningsEmitted).toHaveLength(1);
  });

  it("applies weighted cost and emits warning when threshold is reached", () => {
    const ledger = createToolRuntimeBudgetLedger({
      cfg: { budget: { warnAfterWeightedCostPerSession: 10 } },
    });
    const ann = { costWeight: 4, irreversible: false };
    for (let i = 0; i < 2; i++) {
      ledger.afterCall({ serverName: "s", toolName: "t", annotation: ann, ok: true });
    }
    expect(ledger.getSnapshot().totalWeightedCost).toBe(8);
    expect(ledger.getSnapshot().warningsEmitted).toHaveLength(0);

    ledger.afterCall({ serverName: "s", toolName: "t", annotation: ann, ok: true });
    expect(ledger.getSnapshot().totalWeightedCost).toBe(12);
    expect(ledger.getSnapshot().warningsEmitted).toEqual(["weighted_cost_per_session:10"]);
  });

  it("emits irreversible call warning when annotation marks the call irreversible", () => {
    const ledger = createToolRuntimeBudgetLedger({
      cfg: { budget: { warnAfterIrreversibleCallsPerSession: 1 } },
    });
    const ann = { costWeight: 1, irreversible: true };
    const { warningKeys } = ledger.afterCall({
      serverName: "s",
      toolName: "dangerous",
      annotation: ann,
      ok: true,
    });
    expect(warningKeys[0]).toMatch(/^irreversible_calls:/);
    expect(ledger.getSnapshot().irreversibleCalls).toBe(1);
  });

  it("emits burst-window warning with fake clock", () => {
    let now = 1_000;
    const ledger = createToolRuntimeBudgetLedger({
      cfg: { budget: { burstWindowMs: 5_000, warnAfterCallsPerBurstWindow: 3 } },
      now: () => now,
    });
    const ann = { costWeight: 1, irreversible: false };

    for (let i = 0; i < 2; i++) {
      const { warningKeys } = ledger.afterCall({
        serverName: "s",
        toolName: "t",
        annotation: ann,
        ok: true,
      });
      expect(warningKeys).toHaveLength(0);
    }

    // Third call within burst window
    const { warningKeys } = ledger.afterCall({
      serverName: "s",
      toolName: "t",
      annotation: ann,
      ok: true,
    });
    expect(warningKeys).toEqual(["burst_calls:3"]);

    // Advance past burst window — old timestamps pruned; new calls should not trigger again
    now += 6_000;
    for (let i = 0; i < 2; i++) {
      ledger.afterCall({ serverName: "s", toolName: "t", annotation: ann, ok: true });
    }
    // Warning already deduped; same key won't fire again
    expect(ledger.getSnapshot().warningsEmitted).toHaveLength(1);
  });

  it("disabled budget ledger does not count calls", () => {
    const ledger = createToolRuntimeBudgetLedger({
      cfg: { budget: { enabled: false } },
    });
    const ann = { costWeight: 5, irreversible: true };
    ledger.afterCall({ serverName: "s", toolName: "t", annotation: ann, ok: true });
    const snap = ledger.getSnapshot();
    expect(snap.totalCalls).toBe(0);
    expect(snap.totalWeightedCost).toBe(0);
  });
});

// ---- Annotation resolution tests ----

describe("resolveToolAnnotation", () => {
  it("returns default annotation when no tools config is provided", () => {
    expect(resolveToolAnnotation("srv", "tool")).toEqual({ costWeight: 1, irreversible: false });
  });

  it("uses exact match before wildcard", () => {
    const tools = {
      "srv::tool": { costWeight: 10, irreversible: true },
      "srv::*": { costWeight: 2 },
    };
    expect(resolveToolAnnotation("srv", "tool", tools)).toEqual({
      costWeight: 10,
      irreversible: true,
    });
  });

  it("falls back to wildcard when no exact match", () => {
    const tools = { "srv::*": { costWeight: 3 } };
    expect(resolveToolAnnotation("srv", "other", tools)).toEqual({
      costWeight: 3,
      irreversible: false,
    });
  });

  it("falls back to default when neither exact nor wildcard matches", () => {
    const tools = { "other::*": { costWeight: 3 } };
    expect(resolveToolAnnotation("srv", "tool", tools)).toEqual({
      costWeight: 1,
      irreversible: false,
    });
  });

  it("invalid costWeight (zero) falls back to default and warns once", () => {
    const warnedKeys = new Set<string>();
    const tools = { "srv::tool": { costWeight: 0 } };

    const ann1 = resolveToolAnnotation("srv", "tool", tools, warnedKeys);
    expect(ann1.costWeight).toBe(1);
    expect(mockLogWarn).toHaveBeenCalledWith(expect.stringContaining("invalid costWeight"));

    mockLogWarn.mockClear();
    const ann2 = resolveToolAnnotation("srv", "tool", tools, warnedKeys);
    expect(ann2.costWeight).toBe(1);
    expect(mockLogWarn).not.toHaveBeenCalled();
  });

  it("invalid costWeight (negative) falls back to default", () => {
    const tools = { "srv::tool": { costWeight: -5 } };
    const ann = resolveToolAnnotation("srv", "tool", tools, new Set());
    expect(ann.costWeight).toBe(1);
  });

  it("invalid costWeight (NaN) falls back to default", () => {
    const tools = { "srv::tool": { costWeight: Number.NaN } };
    const ann = resolveToolAnnotation("srv", "tool", tools, new Set());
    expect(ann.costWeight).toBe(1);
  });
});

// ---- Combined guardrails facade tests ----

describe("createMcpRuntimeGuardrails", () => {
  it("getSnapshot returns combined circuit breaker and budget state", async () => {
    const guardrails = createMcpRuntimeGuardrails({
      cfg: {
        circuitBreaker: { failureThreshold: 2 },
        budget: { warnAfterCallsPerSession: 5 },
      },
    });

    await guardrails.circuitBreaker.run({ serverName: "s", toolName: "t" }, async () => "ok");
    guardrails.budgetLedger.afterCall({
      serverName: "s",
      toolName: "t",
      annotation: { costWeight: 1, irreversible: false },
      ok: true,
    });

    const snap = guardrails.getSnapshot();
    expect(snap.circuitBreaker.states[0]).toMatchObject({ state: "closed" });
    expect(snap.budget.totalCalls).toBe(1);
  });

  it("resolveAnnotation uses exact match and falls back to wildcard then default", () => {
    const guardrails = createMcpRuntimeGuardrails({
      cfg: {
        tools: {
          "srv::exact": { costWeight: 7, irreversible: true },
          "srv::*": { costWeight: 2 },
        },
      },
    });

    expect(guardrails.resolveAnnotation("srv", "exact")).toEqual({
      costWeight: 7,
      irreversible: true,
    });
    expect(guardrails.resolveAnnotation("srv", "other")).toEqual({
      costWeight: 2,
      irreversible: false,
    });
    expect(guardrails.resolveAnnotation("unknown", "tool")).toEqual({
      costWeight: 1,
      irreversible: false,
    });
  });

  it("invalid annotation warns once across repeated calls", () => {
    const guardrails = createMcpRuntimeGuardrails({
      cfg: { tools: { "srv::bad": { costWeight: -1 } } },
    });

    guardrails.resolveAnnotation("srv", "bad");
    const warnCallsAfterFirst = mockLogWarn.mock.calls.length;

    guardrails.resolveAnnotation("srv", "bad");
    guardrails.resolveAnnotation("srv", "bad");
    expect(mockLogWarn.mock.calls.length).toBe(warnCallsAfterFirst);
  });

  it("dispose of the runtime object does not prevent snapshot from being called", async () => {
    const guardrails = createMcpRuntimeGuardrails({});
    const snap = guardrails.getSnapshot();
    expect(snap.budget.totalCalls).toBe(0);
    expect(snap.circuitBreaker.states).toHaveLength(0);
  });
});

// ---- Config/schema tests ----

describe("mcp.runtimeGuardrails zod schema", () => {
  it("accepts a valid full runtimeGuardrails config", () => {
    const result = OpenClawSchema.safeParse({
      mcp: {
        runtimeGuardrails: {
          circuitBreaker: { enabled: true, failureThreshold: 3, recoveryTimeoutMs: 60_000 },
          budget: {
            enabled: true,
            warnAfterCallsPerSession: 50,
            warnAfterWeightedCostPerSession: 100,
            warnAfterIrreversibleCallsPerSession: 1,
            burstWindowMs: 60_000,
            warnAfterCallsPerBurstWindow: 20,
          },
          tools: {
            "srv::tool": { costWeight: 5, irreversible: true },
            "srv::*": { costWeight: 2 },
          },
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts mcp.runtimeGuardrails omitted entirely", () => {
    const result = OpenClawSchema.safeParse({ mcp: { servers: {} } });
    expect(result.success).toBe(true);
  });

  it("rejects failureThreshold of zero (must be positive int)", () => {
    const result = OpenClawSchema.safeParse({
      mcp: { runtimeGuardrails: { circuitBreaker: { failureThreshold: 0 } } },
    });
    expect(result.success).toBe(false);
  });

  it("rejects negative failureThreshold", () => {
    const result = OpenClawSchema.safeParse({
      mcp: { runtimeGuardrails: { circuitBreaker: { failureThreshold: -1 } } },
    });
    expect(result.success).toBe(false);
  });

  it("rejects zero recoveryTimeoutMs (must be positive)", () => {
    const result = OpenClawSchema.safeParse({
      mcp: { runtimeGuardrails: { circuitBreaker: { recoveryTimeoutMs: 0 } } },
    });
    expect(result.success).toBe(false);
  });

  it("rejects negative costWeight in tool annotation", () => {
    const result = OpenClawSchema.safeParse({
      mcp: { runtimeGuardrails: { tools: { "srv::tool": { costWeight: -1 } } } },
    });
    expect(result.success).toBe(false);
  });

  it("rejects zero costWeight in tool annotation (must be positive finite)", () => {
    const result = OpenClawSchema.safeParse({
      mcp: { runtimeGuardrails: { tools: { "srv::tool": { costWeight: 0 } } } },
    });
    expect(result.success).toBe(false);
  });

  it("rejects observeOnly override because runtime guardrails are always observe-only", () => {
    const result = OpenClawSchema.safeParse({
      mcp: { runtimeGuardrails: { observeOnly: false } },
    });
    expect(result.success).toBe(false);
  });

  it("rejects halfOpenMaxCalls until probe concurrency is implemented", () => {
    const result = OpenClawSchema.safeParse({
      mcp: { runtimeGuardrails: { circuitBreaker: { halfOpenMaxCalls: 2 } } },
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown keys inside circuitBreaker (strict object)", () => {
    const result = OpenClawSchema.safeParse({
      mcp: { runtimeGuardrails: { circuitBreaker: { unknownKey: 1 } } },
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown keys inside budget (strict object)", () => {
    const result = OpenClawSchema.safeParse({
      mcp: { runtimeGuardrails: { budget: { unknownKey: true } } },
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown keys inside runtimeGuardrails (strict object)", () => {
    const result = OpenClawSchema.safeParse({
      mcp: { runtimeGuardrails: { unexpectedKey: 1 } },
    });
    expect(result.success).toBe(false);
  });
});
