import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readA2UIJsonlFile } from "./a2ui-jsonl-file.js";

const FILE_BYTE_LIMIT = 25 * 1024 * 1024;

describe("readA2UIJsonlFile", () => {
  let tempRoot: string | undefined;

  afterEach(async () => {
    if (tempRoot) {
      await rm(tempRoot, { recursive: true, force: true });
      tempRoot = undefined;
    }
  });

  it("reads a valid A2UI payload above the former 8 MiB limit", async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "openclaw-canvas-jsonl-"));
    const filePath = path.join(tempRoot, "large.jsonl");
    const jsonl = JSON.stringify({
      surfaceUpdate: {
        surfaceId: "main",
        components: [
          {
            id: "text",
            component: {
              Text: {
                text: { literalString: "x".repeat(9 * 1024 * 1024) },
              },
            },
          },
        ],
      },
    });
    expect(Buffer.byteLength(jsonl)).toBeGreaterThan(8 * 1024 * 1024);
    expect(Buffer.byteLength(jsonl)).toBeLessThan(FILE_BYTE_LIMIT);
    await writeFile(filePath, jsonl);

    await expect(readA2UIJsonlFile(filePath)).resolves.toBe(jsonl);
  });

  it("rejects an oversized file before reading it into memory", async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "openclaw-canvas-jsonl-"));
    const filePath = path.join(tempRoot, "oversized.jsonl");
    await writeFile(filePath, "");
    await truncate(filePath, FILE_BYTE_LIMIT + 1);

    await expect(readA2UIJsonlFile(filePath)).rejects.toThrow(
      `A2UI JSONL file exceeds ${FILE_BYTE_LIMIT} bytes`,
    );
  });
});
