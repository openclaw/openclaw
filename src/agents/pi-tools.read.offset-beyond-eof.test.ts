import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createReadTool } from "@mariozechner/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOpenClawReadTool } from "./pi-tools.read.js";
import type { AnyAgentTool } from "./pi-tools.types.js";

function getTextContent(result: { content?: Array<{ type: string; text?: string }> }) {
  const textBlock = result.content?.find((block) => block.type === "text");
  return textBlock?.text ?? "";
}

describe("createOpenClawReadTool offset beyond EOF recovery", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-read-offset-eof-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function createWrappedReadTool() {
    return createOpenClawReadTool(createReadTool(tmpDir) as unknown as AnyAgentTool);
  }

  it("clamps a positive offset beyond EOF when limit is explicit", async () => {
    await fs.writeFile(path.join(tmpDir, "notes.txt"), "one\ntwo\nthree", "utf8");
    const readTool = createWrappedReadTool();

    const result = await readTool.execute("read-offset-limit", {
      path: "notes.txt",
      offset: 99,
      limit: 10,
    });

    expect(getTextContent(result)).toBe("three");
  });

  it("skips the synthetic trailing empty line when clamping newline-terminated files", async () => {
    await fs.writeFile(path.join(tmpDir, "notes.txt"), "one\ntwo\nthree\n", "utf8");
    const readTool = createWrappedReadTool();

    const result = await readTool.execute("read-offset-trailing-newline", {
      path: "notes.txt",
      offset: 99,
      limit: 10,
    });

    expect(getTextContent(result)).toBe("three\n");
  });

  it("clamps a positive offset beyond EOF on the adaptive read path", async () => {
    await fs.writeFile(path.join(tmpDir, "notes.txt"), "one\ntwo\nthree", "utf8");
    const readTool = createWrappedReadTool();

    const result = await readTool.execute("read-offset-adaptive", {
      path: "notes.txt",
      offset: 99,
    });

    expect(getTextContent(result)).toBe("three");
  });

  it("does not crash for an empty file with a positive offset beyond EOF", async () => {
    await fs.writeFile(path.join(tmpDir, "empty.txt"), "", "utf8");
    const readTool = createWrappedReadTool();

    const result = await readTool.execute("read-offset-empty", {
      path: "empty.txt",
      offset: 99,
      limit: 10,
    });

    expect(getTextContent(result)).toBe("");
  });

  it("returns already-read adaptive content if pagination reaches EOF", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({
        content: [
          {
            type: "text",
            text: "one\n\n[1 more lines in file. Use offset=2 to continue.]",
          },
        ],
        details: {
          truncation: {
            truncated: true,
            outputLines: 1,
            firstLineExceedsLimit: false,
          },
        },
      })
      .mockRejectedValueOnce(new Error("Offset 2 is beyond end of file (1 lines total)"));
    const readTool = createOpenClawReadTool({
      name: "read",
      description: "test read",
      execute,
    } as unknown as AnyAgentTool);

    const result = await readTool.execute("read-offset-paging-eof", {
      path: "notes.txt",
      offset: 1,
    });

    expect(getTextContent(result)).toBe("one");
    expect(execute).toHaveBeenCalledTimes(2);
  });
});
