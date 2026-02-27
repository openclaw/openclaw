import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { createOpenClawCodingTools } from "./pi-tools.js";
import {
  expectReadWriteEditTools,
  expectReadWriteTools,
  getTextContent,
} from "./test-helpers/pi-tools-fs-helpers.js";
import { withUnsafeMountedSandboxHarness } from "./test-helpers/unsafe-mounted-sandbox.js";

vi.mock("../infra/shell-env.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../infra/shell-env.js")>();
  return { ...mod, getShellPathFromLoginShell: () => null };
});

type ToolWithExecute = {
  execute: (toolCallId: string, args: unknown, signal?: AbortSignal) => Promise<unknown>;
};
describe("tools.fs.workspaceOnly", () => {
  it("defaults to allowing sandbox mounts outside the workspace root", async () => {
    await withUnsafeMountedSandboxHarness(async ({ sandboxRoot, agentRoot, sandbox }) => {
      await fs.writeFile(path.join(agentRoot, "secret.txt"), "shh", "utf8");

      const tools = createOpenClawCodingTools({ sandbox, workspaceDir: sandboxRoot });
      const { readTool, writeTool } = expectReadWriteTools(tools);

      const readResult = await readTool?.execute("t1", { path: "/agent/secret.txt" });
      expect(getTextContent(readResult)).toContain("shh");

      await writeTool?.execute("t2", { path: "/agent/owned.txt", content: "x" });
      expect(await fs.readFile(path.join(agentRoot, "owned.txt"), "utf8")).toBe("x");
    });
  });

  it("rejects sandbox mounts outside the workspace root when enabled", async () => {
    await withUnsafeMountedSandboxHarness(async ({ sandboxRoot, agentRoot, sandbox }) => {
      await fs.writeFile(path.join(agentRoot, "secret.txt"), "shh", "utf8");

      const cfg = { tools: { fs: { workspaceOnly: true } } } as unknown as OpenClawConfig;
      const tools = createOpenClawCodingTools({ sandbox, workspaceDir: sandboxRoot, config: cfg });
      const { readTool, writeTool, editTool } = expectReadWriteEditTools(tools);

      await expect(readTool?.execute("t1", { path: "/agent/secret.txt" })).rejects.toThrow(
        /Path escapes sandbox root/i,
      );

      await expect(
        writeTool?.execute("t2", { path: "/agent/owned.txt", content: "x" }),
      ).rejects.toThrow(/Path escapes sandbox root/i);
      await expect(fs.stat(path.join(agentRoot, "owned.txt"))).rejects.toMatchObject({
        code: "ENOENT",
      });

      await expect(
        editTool?.execute("t3", { path: "/agent/secret.txt", oldText: "shh", newText: "nope" }),
      ).rejects.toThrow(/Path escapes sandbox root/i);
      expect(await fs.readFile(path.join(agentRoot, "secret.txt"), "utf8")).toBe("shh");
    });
  });

  it("enforces apply_patch workspace-only in sandbox mounts by default", async () => {
    await withUnsafeMountedSandboxHarness(async ({ sandboxRoot, agentRoot, sandbox }) => {
      const cfg: OpenClawConfig = {
        tools: {
          allow: ["read", "exec"],
          exec: { applyPatch: { enabled: true } },
        },
      };
      const tools = createOpenClawCodingTools({
        sandbox,
        workspaceDir: sandboxRoot,
        config: cfg,
        modelProvider: "openai",
        modelId: "gpt-5.2",
      });
      const applyPatchTool = tools.find((t) => t.name === "apply_patch") as
        | ToolWithExecute
        | undefined;
      if (!applyPatchTool) {
        throw new Error("apply_patch tool missing");
      }

      const patch = `*** Begin Patch
*** Add File: /agent/pwned.txt
+owned-by-apply-patch
*** End Patch`;

      await expect(applyPatchTool.execute("t1", { input: patch })).rejects.toThrow(
        /Path escapes sandbox root/i,
      );
      await expect(fs.stat(path.join(agentRoot, "pwned.txt"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
  });

  it("allows apply_patch outside workspace root when explicitly disabled", async () => {
    await withUnsafeMountedSandboxHarness(async ({ sandboxRoot, agentRoot, sandbox }) => {
      const cfg: OpenClawConfig = {
        tools: {
          allow: ["read", "exec"],
          exec: { applyPatch: { enabled: true, workspaceOnly: false } },
        },
      };
      const tools = createOpenClawCodingTools({
        sandbox,
        workspaceDir: sandboxRoot,
        config: cfg,
        modelProvider: "openai",
        modelId: "gpt-5.2",
      });
      const applyPatchTool = tools.find((t) => t.name === "apply_patch") as
        | ToolWithExecute
        | undefined;
      if (!applyPatchTool) {
        throw new Error("apply_patch tool missing");
      }

      const patch = `*** Begin Patch
*** Add File: /agent/pwned.txt
+owned-by-apply-patch
*** End Patch`;

      await applyPatchTool.execute("t2", { input: patch });
      expect(await fs.readFile(path.join(agentRoot, "pwned.txt"), "utf8")).toBe(
        "owned-by-apply-patch\n",
      );
    });
  });
});
