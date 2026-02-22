import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
/**
 * Phase 0 — cold-store.streaming.test.ts
 *
 * Verifies that ColdStore.loadAll() uses streaming (readline) rather than
 * reading the entire file into memory via readFile + split.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("cold-store streaming", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "cs-stream-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("loadAll() does NOT call fs.readFile (uses streaming instead)", async () => {
    const { ColdStore } = await import("../core/cold-store.js");
    const cold = new ColdStore(tmpDir);
    await cold.ensureReady();

    // Write a few lines
    const filePath = join(tmpDir, "segments.jsonl");
    const lines = [];
    for (let i = 0; i < 100; i++) {
      lines.push(
        JSON.stringify({
          id: `s${i}`,
          sessionId: "sess",
          timestamp: Date.now(),
          role: "user",
          content: `message ${i}`,
          tokens: 3,
        }),
      );
    }
    writeFileSync(filePath, lines.join("\n") + "\n");

    // Spy on fs.readFile — it should NOT be called during loadAll()
    const readFileSpy = vi.spyOn(fs, "readFile");

    const loaded: unknown[] = [];
    for await (const seg of cold.loadAll()) {
      loaded.push(seg);
    }

    expect(loaded).toHaveLength(100);
    // Key assertion: readFile must not have been called by loadAll
    expect(readFileSpy).not.toHaveBeenCalled();

    readFileSpy.mockRestore();
  });

  it("loadAll() handles corrupt lines gracefully in streaming mode", async () => {
    const { ColdStore } = await import("../core/cold-store.js");
    const cold = new ColdStore(tmpDir);
    await cold.ensureReady();

    const filePath = join(tmpDir, "segments.jsonl");
    const validLine = JSON.stringify({
      id: "s1",
      sessionId: "sess",
      timestamp: Date.now(),
      role: "user",
      content: "valid message",
      tokens: 3,
    });
    // Mix valid, corrupt, empty lines
    writeFileSync(filePath, `${validLine}\n{broken json\n\n${validLine.replace("s1", "s2")}\n`);

    const loaded: unknown[] = [];
    for await (const seg of cold.loadAll()) {
      loaded.push(seg);
    }

    // Should load 2 valid lines, skip the corrupt one and empty line
    expect(loaded).toHaveLength(2);
  });

  it("append() does NOT include embedding in JSONL by default", async () => {
    const { ColdStore } = await import("../core/cold-store.js");
    const cold = new ColdStore(tmpDir);
    await cold.ensureReady();

    await cold.append({
      id: "s1",
      sessionId: "sess",
      timestamp: Date.now(),
      role: "user",
      content: "hello",
      tokens: 1,
      // Note: no embedding field
    });

    const filePath = join(tmpDir, "segments.jsonl");
    const raw = await fs.readFile(filePath, "utf8");
    const obj = JSON.parse(raw.trim());
    // Should not have embedding key (or should be undefined)
    expect(obj.embedding).toBeUndefined();
  });
});
