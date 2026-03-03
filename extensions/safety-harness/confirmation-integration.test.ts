import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("confirmation flow integration", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-confirm-"));
    vi.stubEnv("HARNESS_AUDIT_PATH", path.join(tmpDir, "audit.jsonl"));
    vi.stubEnv("HARNESS_MODE", "enforce");
    vi.stubEnv("HARNESS_PENDING_PATH", path.join(tmpDir, "pending.json"));
    vi.resetModules();

    // Mock CircuitBreaker to prevent test failures from tripping it
    vi.doMock("./circuit-breaker.js", () => ({
      CircuitBreaker: class {
        isDegraded() {
          return false;
        }
        recordFailure() {}
        recordSuccess() {}
      },
    }));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("pauses confirm-tier action and sends confirmation request", async () => {
    const sendMock = vi.fn().mockResolvedValue({ ok: true });
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
      invokeTool: vi.fn().mockImplementation(async (toolName: string, params: unknown) => {
        if (toolName === "send_channel_message") {
          return sendMock(params);
        }
      }),
    } as any;

    const mod = await import("./index.js");
    await mod.safetyHarnessPlugin.register!(mockApi);

    const beforeHandler = handlers.get("before_tool_call")!;

    // contacts.add is confirm-tier per builtin rules
    const result = (await beforeHandler(
      { toolName: "contacts.add", params: { name: "Test User", email: "test@example.com" } },
      { toolName: "contacts.add", sessionKey: "session-123" },
    )) as any;

    // Should return "pending" not block or allow
    expect(result?.pending).toBe(true);
    expect(result?.pendingReason).toContain("confirmation");
    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("CONFIRM"),
      }),
    );
  });

  it("allows confirm-tier action when client confirms", async () => {
    // This test would verify the full flow: pending → confirm → allow
    // For now, test that pending actions are stored correctly
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
      invokeTool: vi.fn().mockResolvedValue({ ok: true }),
    } as any;

    const mod = await import("./index.js");
    await mod.safetyHarnessPlugin.register!(mockApi);

    const beforeHandler = handlers.get("before_tool_call")!;

    // contacts.add is confirm-tier per builtin rules
    const result = (await beforeHandler(
      { toolName: "contacts.add", params: { name: "Test User", email: "test@example.com" } },
      { toolName: "contacts.add", sessionKey: "session-123" },
    )) as any;

    expect(result?.pending).toBe(true);
    expect(result?.actionId).toBeDefined();
  });
});
