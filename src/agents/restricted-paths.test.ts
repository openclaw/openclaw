import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOpenClawCodingTools } from "./pi-tools.js";

async function withTempDir<T>(prefix: string, fn: (dir: string) => Promise<T>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe("VULN-201: workspace hook write restriction", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.resetModules();
  });

  it("rejects write to hooks directory within workspace", async () => {
    await withTempDir("openclaw-ws-", async (workspaceDir) => {
      // Create hooks directory within workspace
      const hooksDir = path.join(workspaceDir, "hooks");
      await fs.mkdir(hooksDir, { recursive: true });

      const tools = createOpenClawCodingTools({ workspaceDir });
      const writeTool = tools.find((tool) => tool.name === "write");
      expect(writeTool).toBeDefined();

      // Attempt to write a malicious hook handler
      const maliciousHookPath = path.join(hooksDir, "backdoor", "handler.ts");

      await expect(
        writeTool?.execute("hook-write", {
          path: maliciousHookPath,
          content: "export default function backdoor() { /* malicious */ }",
        }),
      ).rejects.toThrow(/hooks.*restricted|restricted.*hooks/i);
    });
  });

  it("rejects write to nested path under hooks directory", async () => {
    await withTempDir("openclaw-ws-", async (workspaceDir) => {
      const hooksDir = path.join(workspaceDir, "hooks");
      await fs.mkdir(hooksDir, { recursive: true });

      const tools = createOpenClawCodingTools({ workspaceDir });
      const writeTool = tools.find((tool) => tool.name === "write");
      expect(writeTool).toBeDefined();

      // Try to write deep within hooks directory
      const deepPath = path.join(hooksDir, "evil", "deep", "handler.ts");

      await expect(
        writeTool?.execute("hook-write-deep", {
          path: deepPath,
          content: "malicious code",
        }),
      ).rejects.toThrow(/hooks.*restricted|restricted.*hooks/i);
    });
  });

  it("rejects edit to files under hooks directory", async () => {
    await withTempDir("openclaw-ws-", async (workspaceDir) => {
      const hooksDir = path.join(workspaceDir, "hooks", "existing");
      await fs.mkdir(hooksDir, { recursive: true });
      const existingFile = path.join(hooksDir, "handler.ts");
      await fs.writeFile(existingFile, "export default function() { return 'safe'; }", "utf8");

      const tools = createOpenClawCodingTools({ workspaceDir });
      const editTool = tools.find((tool) => tool.name === "edit");
      expect(editTool).toBeDefined();

      // Attempt to modify existing hook
      await expect(
        editTool?.execute("hook-edit", {
          path: existingFile,
          oldText: "safe",
          newText: "malicious",
        }),
      ).rejects.toThrow(/hooks.*restricted|restricted.*hooks/i);
    });
  });

  it("rejects write to CONFIG_DIR hooks directory", async () => {
    await withTempDir("openclaw-config-", async (configDir) => {
      // Override CONFIG_DIR via environment variable
      process.env.OPENCLAW_STATE_DIR = configDir;

      // Create managed hooks directory
      const managedHooksDir = path.join(configDir, "hooks");
      await fs.mkdir(managedHooksDir, { recursive: true });

      await withTempDir("openclaw-ws-", async (workspaceDir) => {
        // Reimport to pick up new CONFIG_DIR
        vi.resetModules();
        const { createOpenClawCodingTools: freshCreate } = await import("./pi-tools.js");

        const tools = freshCreate({ workspaceDir });
        const writeTool = tools.find((tool) => tool.name === "write");
        expect(writeTool).toBeDefined();

        // Attempt to write to managed hooks directory
        const maliciousPath = path.join(managedHooksDir, "backdoor", "handler.ts");

        await expect(
          writeTool?.execute("config-hook-write", {
            path: maliciousPath,
            content: "export default function backdoor() {}",
          }),
        ).rejects.toThrow(/hooks.*restricted|restricted.*hooks/i);
      });
    });
  });

  it("allows write to non-hooks directories", async () => {
    await withTempDir("openclaw-ws-", async (workspaceDir) => {
      const tools = createOpenClawCodingTools({ workspaceDir });
      const writeTool = tools.find((tool) => tool.name === "write");
      expect(writeTool).toBeDefined();

      // Write to a normal file should work
      const safePath = path.join(workspaceDir, "src", "normal.ts");

      await writeTool?.execute("safe-write", {
        path: safePath,
        content: "export const x = 1;",
      });

      const written = await fs.readFile(safePath, "utf8");
      expect(written).toBe("export const x = 1;");
    });
  });

  it("allows write to directories named similar to hooks but not exact", async () => {
    await withTempDir("openclaw-ws-", async (workspaceDir) => {
      const tools = createOpenClawCodingTools({ workspaceDir });
      const writeTool = tools.find((tool) => tool.name === "write");
      expect(writeTool).toBeDefined();

      // These should NOT be blocked (similar names but not 'hooks')
      const safeNames = ["webhook", "hooks-backup", "my-hooks", "hooksmith"];

      for (const safeName of safeNames) {
        const safePath = path.join(workspaceDir, safeName, "handler.ts");

        await writeTool?.execute(`safe-${safeName}`, {
          path: safePath,
          content: `// ${safeName} content`,
        });

        const written = await fs.readFile(safePath, "utf8");
        expect(written).toContain(safeName);
      }
    });
  });

  it("rejects write to hooks with relative path that resolves to hooks", async () => {
    await withTempDir("openclaw-ws-", async (workspaceDir) => {
      const hooksDir = path.join(workspaceDir, "hooks");
      await fs.mkdir(hooksDir, { recursive: true });

      const tools = createOpenClawCodingTools({ workspaceDir });
      const writeTool = tools.find((tool) => tool.name === "write");
      expect(writeTool).toBeDefined();

      // Try path traversal that ends up in hooks
      const traversalPath = "src/../hooks/evil/handler.ts";

      await expect(
        writeTool?.execute("traversal-write", {
          path: traversalPath,
          content: "malicious",
        }),
      ).rejects.toThrow(/hooks.*restricted|restricted.*hooks/i);
    });
  });
});
