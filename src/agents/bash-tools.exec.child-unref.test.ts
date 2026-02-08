import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("bash exec child.unref for background processes", () => {
  // Use process.cwd() to get the project root
  const sourcePath = `${process.cwd()}/src/agents/bash-tools.exec.ts`;

  it("has child.unref() calls for detached processes", async () => {
    // Read the source file and verify the pattern exists
    const source = await fs.readFile(sourcePath, "utf-8");

    // Count the number of child.unref?.() calls
    const unrefCalls = (source.match(/child\.unref\?\.\(\)/g) || []).length;

    // Should find 3 occurrences (sandbox, PTY fallback, non-PTY)
    expect(unrefCalls).toBe(3);

    // Verify the guard condition exists: !usedFallback && process.platform !== "win32"
    const guardConditionCount = (
      source.match(/!usedFallback && process\.platform !== "win32"/g) || []
    ).length;
    expect(guardConditionCount).toBe(3);
  });

  it("captures usedFallback from spawnWithFallback result", async () => {
    const source = await fs.readFile(sourcePath, "utf-8");

    // Verify that we destructure usedFallback from the result
    const destructureCount = (
      source.match(/const \{ child: spawned, usedFallback \} = await spawnWithFallback/g) || []
    ).length;

    expect(destructureCount).toBe(3);
  });
});
