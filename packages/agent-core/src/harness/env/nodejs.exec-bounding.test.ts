// Agent Core tests cover nodejs exec output bounding behavior.
import { describe, expect, it } from "vitest";
import { NodeExecutionEnv } from "./nodejs.js";

describe("NodeExecutionEnv exec output bounding", () => {
  const env = new NodeExecutionEnv({ cwd: process.cwd() });

  it("returns full output when under the cap", async () => {
    const result = await env.exec('printf "hello"', { maxOutputBytes: 1024 });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected ok");
    }
    expect(result.value.stdout).toBe("hello");
    expect(result.value.stdout).not.toContain("[output truncated]");
  });

  it("truncates stdout when output exceeds maxOutputBytes", async () => {
    // Produce ~10 KB of output with a 1 KB cap
    const result = await env.exec("node -e 'process.stdout.write(\"x\".repeat(10_000))'", {
      maxOutputBytes: 1024,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected ok");
    }
    expect(result.value.stdout.length).toBeLessThanOrEqual(1200);
    expect(result.value.stdout).toContain("[output truncated]");
  });

  it("truncates stderr when output exceeds maxOutputBytes", async () => {
    const result = await env.exec("node -e 'process.stderr.write(\"y\".repeat(10_000))'", {
      maxOutputBytes: 1024,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected ok");
    }
    expect(result.value.stderr).toContain("[output truncated]");
  });

  it("does not truncate when maxOutputBytes is high enough", async () => {
    const result = await env.exec("node -e 'process.stdout.write(\"z\".repeat(500))'", {
      maxOutputBytes: 64 * 1024,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected ok");
    }
    expect(result.value.stdout).toBe("z".repeat(500));
    expect(result.value.stdout).not.toContain("[output truncated]");
  });

  it("truncates at a UTF-8 byte boundary, not a code-unit boundary", async () => {
    // "🙂" is 4 UTF-8 bytes. Cap at 5 bytes should keep one emoji (4 bytes) plus one ASCII (1 byte).
    const result = await env.exec(
      'node -e \'process.stdout.write("🙂🙂🙂🙂🙂" + "x".repeat(1000))\'',
      { maxOutputBytes: 5 },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected ok");
    }
    expect(result.value.stdout).toContain("[output truncated]");
    expect(Buffer.byteLength(result.value.stdout, "utf8")).toBeLessThanOrEqual(5 + 64);
    expect(Buffer.byteLength(result.value.stdout, "utf8")).toBeGreaterThanOrEqual(5);
  });

  it("keeps streaming callbacks firing after capture truncation", async () => {
    let callbackBytes = 0;
    let callbackChunks = 0;
    const result = await env.exec("node -e 'process.stdout.write(\"x\".repeat(10_000))'", {
      maxOutputBytes: 1024,
      onStdout: (chunk: string) => {
        callbackBytes += chunk.length;
        callbackChunks++;
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected ok");
    }
    expect(result.value.stdout).toContain("[output truncated]");
    expect(callbackBytes).toBe(10_000);
    expect(callbackChunks).toBeGreaterThan(0);
  });
});
