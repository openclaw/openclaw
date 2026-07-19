import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_A2UI_JSONL_FILE_BYTES, readA2UIJsonlFile } from "./a2ui-jsonl-file.js";

describe("readA2UIJsonlFile", () => {
  let tempRoot: string | undefined;

  afterEach(async () => {
    if (tempRoot) {
      await rm(tempRoot, { recursive: true, force: true });
      tempRoot = undefined;
    }
  });

  it("reads a valid A2UI payload near the file limit", async () => {
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
                text: { literalString: "x".repeat(MAX_A2UI_JSONL_FILE_BYTES - 1024) },
              },
            },
          },
        ],
      },
    });
    expect(Buffer.byteLength(jsonl)).toBeLessThan(MAX_A2UI_JSONL_FILE_BYTES);
    await writeFile(filePath, jsonl);

    await expect(readA2UIJsonlFile(filePath)).resolves.toBe(jsonl);
  });

  it("rejects an oversized file before reading it into memory", async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "openclaw-canvas-jsonl-"));
    const filePath = path.join(tempRoot, "oversized.jsonl");
    await writeFile(filePath, "");
    await truncate(filePath, MAX_A2UI_JSONL_FILE_BYTES + 1);

    await expect(readA2UIJsonlFile(filePath)).rejects.toThrow(
      `A2UI JSONL file exceeds ${MAX_A2UI_JSONL_FILE_BYTES} bytes`,
    );
  });
});
