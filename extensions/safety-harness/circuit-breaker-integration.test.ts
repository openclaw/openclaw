import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// extensions/safety-harness/circuit-breaker-integration.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("circuit breaker integration", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-cb-"));
    vi.stubEnv("HARNESS_AUDIT_PATH", path.join(tmpDir, "audit.jsonl"));
    vi.stubEnv("HARNESS_MODE", "enforce");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("blocks tool call when harness throws (fail-closed)", async () => {
    const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
    const mockApi = {
      id: "safety-harness",
      name: "Safety Harness",
      source: "test",
      config: {},
      pluginConfig: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      on: vi.fn((hookName: string, handler: (...args: unknown[]) => Promise<unknown>) => {
        handlers.set(hookName, handler);
      }),
    } as any;

    vi.resetModules();

    // Mock the engine to throw
    vi.doMock("./engine.js", () => ({
      RulesEngine: class {
        classify() {
          throw new Error("simulated harness crash");
        }
        setOperatorRules() {}
        setClientRules() {}
      },
    }));

    const mod = await import("./index.js");
    await mod.safetyHarnessPlugin.register!(mockApi);
    const handler = handlers.get("before_tool_call")!;

    // Should fail-closed: block the call
    const result = (await handler(
      { toolName: "email.get", params: {} },
      { toolName: "email.get" },
    )) as any;
    expect(result?.block).toBe(true);
    expect(result?.blockReason).toContain("Safety check unavailable");
  });
});
