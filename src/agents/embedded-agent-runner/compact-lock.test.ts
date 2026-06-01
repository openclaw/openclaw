import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("embedded compaction transcript lock", () => {
  it("opts into same-process reentrant locking for preflight compaction", async () => {
    const sourcePath = fileURLToPath(new URL("./compact.ts", import.meta.url));
    const source = await fs.readFile(sourcePath, "utf8");
    const lockCall = source.match(
      /const sessionLock = await acquireSessionWriteLock\(\{[\s\S]*?\n\s*\}\);/,
    )?.[0];

    expect(lockCall).toBeTruthy();
    expect(lockCall).toContain("allowReentrant: true");
  });
});
