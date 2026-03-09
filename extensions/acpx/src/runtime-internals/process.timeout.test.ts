import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { spawnAndCollect } from "./process.js";

describe("spawnAndCollect timeout (fixes #41014)", () => {
  it("should complete quickly for fast commands", async () => {
    const start = Date.now();
    const result = await spawnAndCollect({
      command: "echo",
      args: ["hello"],
      cwd: process.cwd(),
      timeoutMs: 3000,
    });
    const elapsed = Date.now() - start;

    expect(result.error).toBeNull();
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe("hello");
    expect(elapsed).toBeLessThan(1000); // Should complete in <1s
  });

  it("should timeout for slow commands", async () => {
    const start = Date.now();
    const result = await spawnAndCollect({
      command: "sleep",
      args: ["10"], // 10 second sleep
      cwd: process.cwd(),
      timeoutMs: 500, // 500ms timeout
    });
    const elapsed = Date.now() - start;

    expect(result.error).toBeTruthy();
    expect(result.error?.message).toContain("timed out");
    expect(elapsed).toBeLessThan(2000); // Should timeout in <2s (500ms + cleanup)
  });

  it("should use default timeout when not specified", async () => {
    const start = Date.now();
    const result = await spawnAndCollect({
      command: "echo",
      args: ["test"],
      cwd: process.cwd(),
    });
    const elapsed = Date.now() - start;

    expect(result.error).toBeNull();
    expect(result.code).toBe(0);
    expect(elapsed).toBeLessThan(3000); // Default timeout is 3000ms
  });
});
