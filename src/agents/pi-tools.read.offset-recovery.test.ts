import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSandboxedReadTool } from "./pi-tools.read.js";
import { createHostSandboxFsBridge } from "./test-helpers/host-sandbox-fs-bridge.js";

function extractToolText(result: unknown): string {
  if (!result || typeof result !== "object") {
    return "";
  }
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return "";
  }
  const textBlock = content.find((block) => {
    return (
      block &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
    );
  }) as { text?: string } | undefined;
  return textBlock?.text ?? "";
}

const tempDirs: string[] = [];

async function createReadFixture(lines: string[]) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-read-offset-recovery-"));
  tempDirs.push(root);
  await fs.writeFile(path.join(root, "sample.txt"), lines.join("\n"), "utf8");
  return createSandboxedReadTool({
    root,
    bridge: createHostSandboxFsBridge(root),
  });
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
});

describe("createOpenClawReadTool offset recovery", () => {
  it("returns a non-fatal recovery result when offset is beyond EOF", async () => {
    const readTool = await createReadFixture(["line-1", "line-2", "line-3", "line-4"]);

    const result = await readTool.execute("read-offset-recovery-1", {
      path: "sample.txt",
      offset: 200,
    });

    const text = extractToolText(result);
    expect(text).toContain("Requested offset 200 is beyond end of file (4 lines total)");
    expect(text).toContain("Returning the last 4 lines from offset=1 instead");
    expect(text).toContain("line-1");
    expect(text).toContain("line-4");
    expect(
      (
        result as {
          details?: {
            offsetRecovery?: Record<string, unknown>;
          };
        }
      ).details?.offsetRecovery,
    ).toMatchObject({
      code: "offset_out_of_range",
      requestedOffset: 200,
      totalLines: 4,
      recoveredOffset: 1,
    });
  });

  it("clamps limited reads to the last valid window instead of throwing", async () => {
    const readTool = await createReadFixture([
      "line-1",
      "line-2",
      "line-3",
      "line-4",
      "line-5",
      "line-6",
    ]);

    const result = await readTool.execute("read-offset-recovery-2", {
      path: "sample.txt",
      offset: 200,
      limit: 2,
    });

    const text = extractToolText(result);
    expect(text).toContain("Requested offset 200 is beyond end of file (6 lines total)");
    expect(text).toContain("Returning the last 2 lines from offset=5 instead");
    expect(text).toContain("line-5");
    expect(text).toContain("line-6");
    expect(text).not.toContain("line-1");
    expect(
      (
        result as {
          details?: {
            offsetRecovery?: Record<string, unknown>;
          };
        }
      ).details?.offsetRecovery,
    ).toMatchObject({
      code: "offset_out_of_range",
      requestedOffset: 200,
      totalLines: 6,
      recoveredOffset: 5,
    });
  });
});
