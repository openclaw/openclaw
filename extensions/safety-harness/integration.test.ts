import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("safety-harness integration (observe mode)", () => {
  let tmpDir: string;
  let beforeToolCallHandler: Function;
  let afterToolCallHandler: Function;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-int-"));
    vi.stubEnv("HARNESS_AUDIT_PATH", path.join(tmpDir, "audit.jsonl"));
    vi.stubEnv("HARNESS_MODE", "observe");

    const handlers = new Map<string, Function>();
    const mockApi = {
      id: "safety-harness",
      name: "Safety Harness",
      source: "test",
      config: {},
      pluginConfig: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      on: vi.fn((hookName: string, handler: Function) => {
        handlers.set(hookName, handler);
      }),
    } as any;

    // Dynamic import to pick up env vars
    vi.resetModules();
    const mod = await import("./index.js");
    await mod.safetyHarnessPlugin.register!(mockApi);

    beforeToolCallHandler = handlers.get("before_tool_call")!;
    afterToolCallHandler = handlers.get("after_tool_call")!;

    expect(beforeToolCallHandler).toBeDefined();
    expect(afterToolCallHandler).toBeDefined();
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
    expect(result?.block).not.toBe(true);
  });

  it("classifies a blocked tool but does NOT block in observe mode", async () => {
    const result = await beforeToolCallHandler(
      { toolName: "contacts.export", params: {} },
      { toolName: "contacts.export" },
    );
    // Observe mode: log but don't block
    expect(result?.block).not.toBe(true);
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

    await new Promise((r) => setTimeout(r, 100));

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

    // Give the async write a moment
    await new Promise((r) => setTimeout(r, 100));

    const auditPath = path.join(tmpDir, "audit.jsonl");
    expect(fs.existsSync(auditPath)).toBe(true);
    const content = fs.readFileSync(auditPath, "utf-8").trim();
    const entry = JSON.parse(content);
    expect(entry.tool).toBe("email.get");
  });
});
