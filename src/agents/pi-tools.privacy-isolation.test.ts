import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@mariozechner/pi-ai", async () => {
  const original =
    await vi.importActual<typeof import("@mariozechner/pi-ai")>("@mariozechner/pi-ai");
  return {
    ...original,
  };
});

vi.mock("@mariozechner/pi-ai/oauth", async () => {
  const actual = await vi.importActual<typeof import("@mariozechner/pi-ai/oauth")>(
    "@mariozechner/pi-ai/oauth",
  );
  return {
    ...actual,
    getOAuthApiKey: () => undefined,
    getOAuthProviders: () => [],
  };
});

import { createHostWorkspaceReadTool } from "./pi-tools.read.js";

describe("Agent privacy isolation via read tool", () => {
  let agentDir: string;
  let agentWorkspace: string;
  let otherAgentDir: string;
  let otherAgentWorkspace: string;
  let privateMemoryFile: string;
  let otherAgentMemoryFile: string;

  beforeEach(async () => {
    // Simulate two agents with separate workspaces (like therapist vs architect)
    agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-privacy-"));
    agentWorkspace = path.join(agentDir, "workspace");
    await fs.mkdir(agentWorkspace);

    otherAgentDir = await fs.mkdtemp(path.join(os.tmpdir(), "other-agent-"));
    otherAgentWorkspace = path.join(otherAgentDir, "workspace");
    await fs.mkdir(otherAgentWorkspace);

    // Create private memory file for "therapist" agent
    await fs.mkdir(path.join(agentDir, "memory"), { recursive: true });
    privateMemoryFile = path.join(agentDir, "MEMORY.md");
    await fs.writeFile(privateMemoryFile, "Private therapy session notes - DO NOT SHARE");

    // Create memory file for "architect" agent
    await fs.mkdir(path.join(otherAgentDir, "memory"), { recursive: true });
    otherAgentMemoryFile = path.join(otherAgentDir, "MEMORY.md");
    await fs.writeFile(otherAgentMemoryFile, "Architect project notes");
  });

  afterEach(async () => {
    await fs.rm(agentDir, { recursive: true, force: true });
    await fs.rm(otherAgentDir, { recursive: true, force: true });
  });

  describe("with workspaceOnly=false (default)", () => {
    it("should allow read tool to access any file when workspaceOnly=false (current behavior)", async () => {
      // When workspaceOnly=false, the read tool should be able to access any file
      // This is the current (potentially unsafe) behavior
      const readTool = createHostWorkspaceReadTool(agentWorkspace, { workspaceOnly: false });

      // Agent should be able to read files in its own workspace
      const ownFile = path.join(agentWorkspace, "some-file.txt");
      await fs.writeFile(ownFile, "workspace content");

      const ownResult = await readTool.execute("test-own-workspace", {
        path: ownFile,
      });
      expect(ownResult.content).toBeDefined();

      // Agent can also read files outside its workspace (current behavior)
      const outsideResult = await readTool.execute("test-outside-workspace", {
        path: otherAgentMemoryFile,
      });
      // Currently this succeeds - this is the privacy issue
      expect(outsideResult.content).toBeDefined();
    });

    it("documents that workspaceOnly=false allows cross-agent file access", async () => {
      // This test documents the current (unsafe) behavior
      // When workspaceOnly=false, there's no isolation between agents
      const readTool = createHostWorkspaceReadTool(agentWorkspace, { workspaceOnly: false });

      const result = await readTool.execute("test-privacy-bypass", {
        path: otherAgentMemoryFile,
      });

      // The bug: agent can read other agent's private memory
      const textContent = result.content.find((c) => c.type === "text");
      expect(textContent?.text).toContain("Architect project notes");
    });
  });

  describe("with workspaceOnly=true (enforced isolation)", () => {
    it("should block read tool from accessing files outside workspace root", async () => {
      // When workspaceOnly=true, the read tool should be restricted to the workspace
      const readTool = createHostWorkspaceReadTool(agentWorkspace, { workspaceOnly: true });

      // Attempting to read other agent's private memory should be blocked
      await expect(
        readTool.execute("test-privacy-block", {
          path: privateMemoryFile,
        }),
      ).rejects.toThrow(/Path escapes (workspace|sandbox) root/);
    });

    it("should block read tool from accessing other agent's memory via absolute path", async () => {
      const readTool = createHostWorkspaceReadTool(agentWorkspace, { workspaceOnly: true });

      await expect(
        readTool.execute("test-other-agent-memory", {
          path: otherAgentMemoryFile,
        }),
      ).rejects.toThrow(/Path escapes (workspace|sandbox) root/);
    });

    it("should block read tool from accessing files via parent path traversal (..)", async () => {
      const readTool = createHostWorkspaceReadTool(agentWorkspace, { workspaceOnly: true });

      // Attempt path traversal to access other agent's files
      const traversalPath = path.join("..", "..", path.basename(otherAgentDir), "MEMORY.md");

      await expect(
        readTool.execute("test-path-traversal", {
          path: traversalPath,
        }),
      ).rejects.toThrow(/Path escapes (workspace|sandbox) root/);
    });

    it("should allow read tool to access files within workspace", async () => {
      // Create a file inside the workspace
      const workspaceFile = path.join(agentWorkspace, "allowed.txt");
      await fs.writeFile(workspaceFile, "This is allowed content");

      const readTool = createHostWorkspaceReadTool(agentWorkspace, { workspaceOnly: true });

      const result = await readTool.execute("test-allowed-read", {
        path: "allowed.txt",
      });

      const textContent = result.content.find((c) => c.type === "text");
      expect(textContent?.text).toContain("This is allowed content");
    });

    it("should block read tool from accessing parent of workspace root", async () => {
      const readTool = createHostWorkspaceReadTool(agentWorkspace, { workspaceOnly: true });

      // Try to access parent directory of workspace
      const parentPath = path.join(agentWorkspace, "..", "parent-file.txt");

      await expect(
        readTool.execute("test-parent-access", {
          path: parentPath,
        }),
      ).rejects.toThrow(/Path escapes (workspace|sandbox) root/);
    });
  });
});
