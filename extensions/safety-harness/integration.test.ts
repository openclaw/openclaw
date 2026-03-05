import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

type HookHandler = (...args: unknown[]) => Promise<unknown>;

// Shared helper: registers the plugin with a mock API and returns the two hook handlers.
async function setupPlugin(
  tmpDir: string,
  mode: "observe" | "enforce",
): Promise<{ beforeToolCallHandler: HookHandler; afterToolCallHandler: HookHandler }> {
  vi.stubEnv("HARNESS_AUDIT_PATH", path.join(tmpDir, "audit.jsonl"));
  vi.stubEnv("HARNESS_MODE", mode);

  const handlers = new Map<string, HookHandler>();
  const mockApi = {
    id: "safety-harness",
    name: "Safety Harness",
    source: "test",
    config: {},
    pluginConfig: {},
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    on: vi.fn((hookName: string, handler: HookHandler) => {
      handlers.set(hookName, handler);
    }),
  } as any;

  vi.resetModules();
  const mod = await import("./index.js");
  await mod.safetyHarnessPlugin.register!(mockApi);

  const beforeToolCallHandler = handlers.get("before_tool_call")!;
  const afterToolCallHandler = handlers.get("after_tool_call")!;
  expect(beforeToolCallHandler).toBeDefined();
  expect(afterToolCallHandler).toBeDefined();
  return { beforeToolCallHandler, afterToolCallHandler };
}

describe("safety-harness integration (observe mode)", () => {
  let tmpDir: string;
  let beforeToolCallHandler: HookHandler;
  let afterToolCallHandler: HookHandler;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-int-"));
    ({ beforeToolCallHandler, afterToolCallHandler } = await setupPlugin(tmpDir, "observe"));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("classifies a read tool as allow and does NOT block (observe mode)", async () => {
    const result = await beforeToolCallHandler(
      { toolName: "email.get", params: {} },
      { toolName: "email.get" },
    );
    // Observe mode: never returns block, even for blocked tools
    expect((result as any)?.block).not.toBe(true);
  });

  it("classifies a blocked tool but does NOT block in observe mode", async () => {
    const result = await beforeToolCallHandler(
      { toolName: "contacts.export", params: {} },
      { toolName: "contacts.export" },
    );
    // Observe mode: log but don't block
    expect((result as any)?.block).not.toBe(true);
  });

  it("audit entry tier reflects actual classification, not hardcoded 'allow'", async () => {
    // contacts.export is classified as "block" by builtin rules
    await beforeToolCallHandler(
      { toolName: "contacts.export", params: {} },
      { toolName: "contacts.export" },
    );
    await afterToolCallHandler(
      { toolName: "contacts.export", params: {}, result: {}, durationMs: 10 },
      { toolName: "contacts.export" },
    );

    const auditPath = path.join(tmpDir, "audit.jsonl");
    expect(fs.existsSync(auditPath)).toBe(true);
    const content = fs.readFileSync(auditPath, "utf-8").trim();
    const entry = JSON.parse(content);
    expect(entry.tool).toBe("contacts.export");
    expect(entry.tier).not.toBe("allow"); // must reflect actual "block" classification
  });

  it("writes audit entry on after_tool_call", async () => {
    await afterToolCallHandler(
      { toolName: "email.get", params: {}, result: { ok: true }, durationMs: 50 },
      { toolName: "email.get" },
    );

    const auditPath = path.join(tmpDir, "audit.jsonl");
    expect(fs.existsSync(auditPath)).toBe(true);
    const content = fs.readFileSync(auditPath, "utf-8").trim();
    const entry = JSON.parse(content);
    expect(entry.tool).toBe("email.get");
  });

  it("audit entry includes chain flags from before_tool_call", async () => {
    await beforeToolCallHandler(
      { toolName: "contacts.export", params: {} },
      { toolName: "contacts.export" },
    );
    await afterToolCallHandler(
      { toolName: "contacts.export", params: {}, result: {}, durationMs: 10 },
      { toolName: "contacts.export" },
    );

    const auditPath = path.join(tmpDir, "audit.jsonl");
    expect(fs.existsSync(auditPath)).toBe(true);
    const content = fs.readFileSync(auditPath, "utf-8").trim();
    const entry = JSON.parse(content);
    // chainFlags should be an array (may be empty for this call with no prior ledger)
    expect(Array.isArray(entry.chainFlags)).toBe(true);
  });
});

describe("safety-harness integration (enforce mode)", () => {
  let tmpDir: string;
  let beforeToolCallHandler: HookHandler;
  let afterToolCallHandler: HookHandler;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-int-enforce-"));
    ({ beforeToolCallHandler, afterToolCallHandler } = await setupPlugin(tmpDir, "enforce"));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("blocks a builtin-blocked tool in enforce mode", async () => {
    const result = (await beforeToolCallHandler(
      { toolName: "contacts.export", params: {} },
      { toolName: "contacts.export" },
    )) as any;
    expect(result?.block).toBe(true);
    expect(result?.blockReason).toBe(
      "Action blocked by safety policy. Please try a different approach.",
    );
  });

  it("does NOT block a safe tool in enforce mode", async () => {
    const result = (await beforeToolCallHandler(
      { toolName: "email.get", params: {} },
      { toolName: "email.get" },
    )) as any;
    expect(result?.block).not.toBe(true);
  });

  it("does NOT record rate limiter or chain detector for a blocked call", async () => {
    // In enforce mode, contacts.export is blocked — it never executed,
    // so quota should not be consumed.
    await beforeToolCallHandler(
      { toolName: "contacts.export", params: {} },
      { toolName: "contacts.export" },
    );
    // after_tool_call for a blocked call: should skip rate/chain recording.
    await afterToolCallHandler(
      { toolName: "contacts.export", params: {}, result: {}, durationMs: 0 },
      { toolName: "contacts.export" },
    );

    // The audit entry should still be written (for observability), but tier = "block".
    const auditPath = path.join(tmpDir, "audit.jsonl");
    expect(fs.existsSync(auditPath)).toBe(true);
    const content = fs.readFileSync(auditPath, "utf-8").trim();
    const entry = JSON.parse(content);
    expect(entry.tier).toBe("block");
    // rateWindow export count should be 0 — blocked call did not consume quota
    expect(entry.rateWindow.export).toBe(0);
  });
});
