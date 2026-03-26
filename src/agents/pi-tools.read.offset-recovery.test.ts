import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOpenClawReadTool, createSandboxedReadTool } from "./pi-tools.read.js";
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

function createStubReadResult(
  text: string,
  details?: Record<string, unknown>,
): AgentToolResult<unknown> {
  return {
    content: [{ type: "text", text }],
    ...(details ? { details } : {}),
  } as AgentToolResult<unknown>;
}

function createWrappedReadTool(
  execute: (
    toolCallId: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<AgentToolResult<unknown>>,
) {
  return createOpenClawReadTool({
    name: "read",
    label: "read",
    description: "test read tool",
    parameters: Type.Object({
      path: Type.String(),
      offset: Type.Optional(Type.Number()),
      limit: Type.Optional(Type.Number()),
    }),
    execute,
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
    expect(text).toContain("Returning up to the last 4 lines from offset=1 instead");
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
    expect(text).toContain("Returning up to the last 2 lines from offset=5 instead");
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

  it("rethrows non-range failures after a recovery retry", async () => {
    const permissionError = new Error("permission changed during recovery");
    const execute = vi.fn(
      async (
        _toolCallId: string,
        args: Record<string, unknown>,
      ): Promise<AgentToolResult<unknown>> => {
        if (args.offset === 200) {
          throw new Error("Offset 200 is beyond end of file (6 lines total)");
        }
        if (args.offset === 5) {
          throw permissionError;
        }
        throw new Error(`unexpected offset ${String(args.offset)}`);
      },
    );
    const readTool = createWrappedReadTool(execute);

    await expect(
      readTool.execute("read-offset-recovery-rethrow", {
        path: "sample.txt",
        offset: 200,
        limit: 2,
      }),
    ).rejects.toThrow("permission changed during recovery");

    expect(execute.mock.calls.map(([, args]) => (args as Record<string, unknown>).offset)).toEqual([
      200, 5,
    ]);
  });

  it("continues adaptive paging from the recovered offset window", async () => {
    const execute = vi.fn(
      async (
        _toolCallId: string,
        args: Record<string, unknown>,
      ): Promise<AgentToolResult<unknown>> => {
        const offset = typeof args.offset === "number" ? args.offset : 1;
        if (offset === 10_000) {
          throw new Error("Offset 10000 is beyond end of file (2500 lines total)");
        }
        if (offset === 501) {
          return createStubReadResult(
            "tail-a\n\n[2399 more lines in file. Use offset=601 to continue.]",
            {
              truncation: {
                truncated: true,
                outputLines: 100,
                firstLineExceedsLimit: false,
              },
            },
          );
        }
        if (offset === 601) {
          return createStubReadResult("tail-b");
        }
        throw new Error(`unexpected offset ${offset}`);
      },
    );
    const readTool = createWrappedReadTool(execute);

    const result = await readTool.execute("read-offset-recovery-adaptive", {
      path: "sample.txt",
      offset: 10_000,
    });

    expect(
      execute.mock.calls.map(([, args]) => (args as Record<string, unknown>).offset ?? 1),
    ).toEqual([10_000, 501, 601]);
    const text = extractToolText(result);
    expect(text).toContain("Requested offset 10000 is beyond end of file (2500 lines total)");
    expect(text).toContain("tail-a");
    expect(text).toContain("tail-b");
    expect(text).not.toContain("Use offset=601 to continue.");
  });
});
