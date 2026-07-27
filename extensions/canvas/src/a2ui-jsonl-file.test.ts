import { truncate, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { readA2UIJsonlFile } from "./a2ui-jsonl-file.js";

const FILE_BYTE_LIMIT = 16 * 1024 * 1024;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("readA2UIJsonlFile", () => {
  it("reads a valid A2UI payload above the former 8 MiB limit", async () => {
    const tempRoot = tempDirs.make("openclaw-canvas-jsonl-");
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
    const tempRoot = tempDirs.make("openclaw-canvas-jsonl-");
    const filePath = path.join(tempRoot, "oversized.jsonl");
    await writeFile(filePath, "");
    await truncate(filePath, FILE_BYTE_LIMIT + 1);

    await expect(readA2UIJsonlFile(filePath)).rejects.toThrow(
      `File exceeds ${FILE_BYTE_LIMIT} bytes`,
    );
  });
});
