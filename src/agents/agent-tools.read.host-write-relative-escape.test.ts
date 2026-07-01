/**
 * Regression tests for relative-path workspace containment on the default
 * (non-`workspaceOnly`) host write/edit tools.
 *
 * In the default posture (`tools.fs.workspaceOnly` unset/false) the built-in
 * write/edit tools may write anywhere on a trusted operator's host via an
 * *absolute* path. A *relative* path, however, is the natural way to address a
 * file inside the workspace, so a relative `..` escape must be rejected rather
 * than silently writing outside the workspace. These tests pin that behaviour and
 * also lock the stricter, opt-in `workspaceOnly` containment (which rejects
 * absolute escapes too).
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createHostWorkspaceEditTool,
  createHostWorkspaceWriteTool,
  wrapToolRejectRelativeWorkspaceEscape,
  wrapToolWorkspaceRootGuard,
} from "./agent-tools.read.js";
import type { AnyAgentTool } from "./agent-tools.types.js";

type ToolResult = { isError?: boolean; content?: { type: string; text?: string }[] };

async function runTool(
  tool: AnyAgentTool,
  filePath: string,
  content: string,
): Promise<{ ok: boolean; error?: string; text?: string }> {
  try {
    const result = await (
      tool as unknown as {
        execute: (
          id: string,
          args: { path: string; content: string },
          signal?: AbortSignal,
        ) => Promise<ToolResult>;
      }
    ).execute("tc", { path: filePath, content });
    if (result?.isError) {
      return { ok: false, error: result.content?.[0]?.text ?? "tool error" };
    }
    return { ok: true, text: result?.content?.[0]?.text };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

describe("default host write/edit relative-path workspace containment", () => {
  let tmpDir = "";

  afterEach(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
      tmpDir = "";
    }
  });

  // Mirrors the default (workspaceOnly=false) wiring in createBuiltinTools, which
  // wraps the host write/edit tools with wrapToolRejectRelativeWorkspaceEscape.
  async function setup() {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-write-rel-escape-"));
    const root = path.join(tmpDir, "workspace");
    await fs.mkdir(root, { recursive: true });
    const outsideFile = path.join(tmpDir, "OUTSIDE_SECRET.txt");
    await fs.writeFile(outsideFile, "ORIGINAL", "utf-8");
    const writeTool = wrapToolRejectRelativeWorkspaceEscape(
      createHostWorkspaceWriteTool(root),
      root,
    );
    const editTool = wrapToolRejectRelativeWorkspaceEscape(createHostWorkspaceEditTool(root), root);
    return { root, outsideFile, writeTool, editTool };
  }

  it.runIf(process.platform !== "win32")(
    "rejects a relative `..` escape and does not modify the outside file",
    async () => {
      const { outsideFile, writeTool } = await setup();

      const result = await runTool(writeTool, "../OUTSIDE_SECRET.txt", "PWNED");

      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/Path escapes workspace root/);
      // The file outside the workspace must be untouched.
      expect(await fs.readFile(outsideFile, "utf-8")).toBe("ORIGINAL");
    },
  );

  it.runIf(process.platform !== "win32")("rejects a deep relative `../../` escape", async () => {
    const { writeTool } = await setup();

    const result = await runTool(writeTool, "../../etc/openclaw_should_not_exist.txt", "PWNED");

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Path escapes workspace root/);
  });

  it.runIf(process.platform !== "win32")(
    "rejects a relative `..` escape for the edit tool too",
    async () => {
      const { outsideFile, editTool } = await setup();

      const result = await runTool(editTool, "../OUTSIDE_SECRET.txt", "PWNED");

      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/Path escapes workspace root/);
      expect(await fs.readFile(outsideFile, "utf-8")).toBe("ORIGINAL");
    },
  );

  it.runIf(process.platform !== "win32")("still allows in-workspace relative writes", async () => {
    const { root, writeTool } = await setup();

    const result = await runTool(writeTool, "sub/ok.txt", "hello");

    expect(result.ok).toBe(true);
    expect(await fs.readFile(path.join(root, "sub", "ok.txt"), "utf-8")).toBe("hello");
  });

  it.runIf(process.platform !== "win32")(
    "still allows absolute writes (documented trusted-operator default)",
    async () => {
      const { writeTool } = await setup();
      const absTarget = path.join(tmpDir, "abs_target.txt");

      const result = await runTool(writeTool, absTarget, "abs-ok");

      expect(result.ok).toBe(true);
      expect(await fs.readFile(absTarget, "utf-8")).toBe("abs-ok");
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects a `~user`-form escape the resolver treats as cwd-relative",
    async () => {
      const { writeTool } = await setup();
      // `~user` is NOT expanded by expandPath, so the sink's resolveToCwd treats
      // it as a plain cwd-relative segment: `~user/../../x` cancels `~user` and
      // `..` climbs out of the workspace. The guard must contain it like any
      // other relative escape (regression for the syntactic "~name == absolute"
      // bypass).
      const escaped = path.join(tmpDir, "TILDE_ESCAPED.txt");
      const result = await runTool(writeTool, "~nobody/../../TILDE_ESCAPED.txt", "PWNED");

      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/Path escapes workspace root/);
      await expect(fs.access(escaped)).rejects.toThrow();
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects a `~user`-form escape for the edit tool too",
    async () => {
      const { editTool } = await setup();
      const escaped = path.join(tmpDir, "TILDE_ESCAPED_EDIT.txt");
      const result = await runTool(editTool, "~nobody/../../TILDE_ESCAPED_EDIT.txt", "PWNED");

      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/Path escapes workspace root/);
      await expect(fs.access(escaped)).rejects.toThrow();
    },
  );
});

describe("opt-in workspaceOnly host write containment (defense lock)", () => {
  let tmpDir = "";

  afterEach(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
      tmpDir = "";
    }
  });

  async function setup() {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-write-ws-only-"));
    const root = path.join(tmpDir, "workspace");
    await fs.mkdir(root, { recursive: true });
    const outsideFile = path.join(tmpDir, "OUTSIDE_SECRET.txt");
    await fs.writeFile(outsideFile, "ORIGINAL", "utf-8");
    // Mirrors the workspaceOnly=true wiring: full containment guard + ops.
    const writeTool = wrapToolWorkspaceRootGuard(
      createHostWorkspaceWriteTool(root, { workspaceOnly: true }),
      root,
    );
    return { root, outsideFile, writeTool };
  }

  it.runIf(process.platform !== "win32")(
    "rejects both relative `..` and absolute escapes when workspaceOnly is enabled",
    async () => {
      const { outsideFile, writeTool } = await setup();

      const rel = await runTool(writeTool, "../OUTSIDE_SECRET.txt", "PWNED");
      expect(rel.ok).toBe(false);
      expect(rel.error).toMatch(/Path escapes/);

      const abs = await runTool(writeTool, outsideFile, "PWNED");
      expect(abs.ok).toBe(false);
      expect(abs.error).toMatch(/Path escapes/);

      expect(await fs.readFile(outsideFile, "utf-8")).toBe("ORIGINAL");
    },
  );
});
