import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

interface FileSnapshot {
  existed: boolean;
  content: string;
}

function snapshotFile(file: string): FileSnapshot {
  if (!existsSync(file)) return { existed: false, content: "" };
  return { existed: true, content: readFileSync(file, "utf8") };
}

function restoreFile(file: string, snapshot: FileSnapshot): void {
  if (snapshot.existed) {
    writeFileSync(file, snapshot.content, "utf8");
    return;
  }
  rmSync(file, { force: true });
}

describe("wemp dedup", () => {
  it("dedup persists seen keys across module reload", async () => {
    const stateDir = mkdtempSync(path.join(tmpdir(), "openclaw-wemp-dedup-"));
    const prevStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = stateDir;

    const dataDir = path.join(stateDir, "wemp");
    mkdirSync(dataDir, { recursive: true });
    const dedupFile = path.join(dataDir, "dedup.json");
    const dedupSnapshot = snapshotFile(dedupFile);

    try {
      writeFileSync(dedupFile, "{}", "utf8");

      const seed = `${Date.now()}-${Math.random()}`;
      const key = `acct-${seed}:openid-${seed}:msg-${seed}:-:-:-`;

      const dedupUrlA = new URL("./dedup.ts", import.meta.url);
      dedupUrlA.searchParams.set("seed", `${seed}-a`);
      const dedupA = await import(dedupUrlA.href);
      expect(dedupA.markIfNew(key, 60_000)).toBe(true);
      expect(dedupA.markIfNew(key, 60_000)).toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 350));

      const persisted = JSON.parse(readFileSync(dedupFile, "utf8")) as Record<string, number>;
      expect(typeof persisted[key]).toBe("number");

      const dedupUrlB = new URL("./dedup.ts", import.meta.url);
      dedupUrlB.searchParams.set("seed", `${seed}-b`);
      const dedupB = await import(dedupUrlB.href);
      expect(dedupB.markIfNew(key, 60_000)).toBe(false);
    } finally {
      restoreFile(dedupFile, dedupSnapshot);
      if (prevStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
      else process.env.OPENCLAW_STATE_DIR = prevStateDir;
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
