/**
 * Regression for #96429: building workspace-only file tools must not eagerly
 * resolve the fs-safe workspace root. An eager resolve floated an unhandled
 * `FsSafeError: root dir not found` (crashing `openclaw doctor --lint` /
 * `--non-interactive`) when the workspace dir was missing and doctor only
 * inspected the tool schema without ever invoking an fs operation.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHostWorkspaceEditTool, createHostWorkspaceWriteTool } from "./agent-tools.read.js";

describe("workspace-only tools resolve their root lazily", () => {
  const rejections: unknown[] = [];
  const onRejection = (reason: unknown) => {
    rejections.push(reason);
  };

  beforeEach(() => {
    rejections.length = 0;
    process.on("unhandledRejection", onRejection);
  });

  afterEach(() => {
    process.off("unhandledRejection", onRejection);
  });

  function missingWorkspaceDir(): string {
    return path.join(os.tmpdir(), `oc-missing-workspace-${process.pid}-${Math.random()}`);
  }

  it("does not float an unhandled rejection when the workspace dir is missing", async () => {
    const root = missingWorkspaceDir();

    // Mirror doctor schema inspection: construct the tools but never run an
    // operation. With eager resolution this floated FsSafeErrors per tool.
    createHostWorkspaceWriteTool(root, { workspaceOnly: true });
    createHostWorkspaceEditTool(root, { workspaceOnly: true });

    // Give any floated promise a chance to reject before asserting.
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });

    expect(rejections).toEqual([]);
  });

  it("resolves the root on first use so writes still create the workspace", async () => {
    const root = missingWorkspaceDir();
    const writeTool = createHostWorkspaceWriteTool(root, { workspaceOnly: true });

    try {
      await writeTool.execute("tc-write", { path: "notes.txt", content: "hello" });

      const written = await fs.readFile(path.join(root, "notes.txt"), "utf-8");
      expect(written).toBe("hello");
      expect(rejections).toEqual([]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
