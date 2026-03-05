import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("safety-harness enforcement", () => {
  let tmpDir: string;
  let beforeToolCallHandler: (...args: unknown[]) => Promise<unknown>;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-enforce-"));
    vi.stubEnv("HARNESS_AUDIT_PATH", path.join(tmpDir, "audit.jsonl"));
    vi.stubEnv("HARNESS_MODE", "enforce");

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

    // Must re-import to get fresh module with new env
    vi.resetModules();
    const mod = await import("./index.js");
    await mod.safetyHarnessPlugin.register!(mockApi);
    beforeToolCallHandler = handlers.get("before_tool_call")!;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("blocks contacts.export in enforce mode", async () => {
    const result = (await beforeToolCallHandler(
      { toolName: "contacts.export", params: {} },
      { toolName: "contacts.export" },
    )) as any;
    expect(result?.block).toBe(true);
    // Gap 10: Generic message — no strategy info leaked
    expect(result?.blockReason).toBe(
      "Action blocked by safety policy. Please try a different approach.",
    );
  });

  it("blocks bulk email deletion (>10) in enforce mode", async () => {
    const result = (await beforeToolCallHandler(
      { toolName: "email.delete", params: { count: 15 } },
      { toolName: "email.delete" },
    )) as any;
    expect(result?.block).toBe(true);
    // Gap 10: Generic message
    expect(result?.blockReason).toBe(
      "Action blocked by safety policy. Please try a different approach.",
    );
  });

  it("allows email.get in enforce mode", async () => {
    const result = (await beforeToolCallHandler(
      { toolName: "email.get", params: {} },
      { toolName: "email.get" },
    )) as any;
    expect(result?.block).not.toBe(true);
  });

  it("does not block small email deletion", async () => {
    const result = (await beforeToolCallHandler(
      { toolName: "email.delete", params: { count: 3 } },
      { toolName: "email.delete" },
    )) as any;
    // verb "delete" → default confirm, but confirm is pass-through in Phase 2
    expect(result?.block).not.toBe(true);
  });
});
