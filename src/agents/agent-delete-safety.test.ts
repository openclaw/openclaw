// Real-filesystem tests for agent-delete-safety helpers — containment
// checks, empty-directory removal, and race-safety (atomic rmdir).
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import { removeEmptyAgentParentDir } from "./agent-delete-safety.js";

describe("removeEmptyAgentParentDir", () => {
  it("removes an empty canonical parent directory", async () => {
    await withStateDirEnv("openclaw-agent-parent-empty-", async ({ stateDir }) => {
      const agentId = "test-agent";
      const canonicalRoot = path.join(stateDir, "agents", agentId);
      const agentDir = path.join(canonicalRoot, "agent");
      await fs.promises.mkdir(agentDir, { recursive: true });
      // Simulate post-deletion state: subdirectory was trashed, parent is empty.
      await fs.promises.rmdir(agentDir);

      await removeEmptyAgentParentDir({ agentDir, agentId, stateDir });

      // The empty canonical parent should be gone.
      await expect(fs.promises.access(canonicalRoot)).rejects.toHaveProperty("code", "ENOENT");
    });
  });

  it("preserves a non-empty canonical parent directory", async () => {
    await withStateDirEnv("openclaw-agent-parent-nonempty-", async ({ stateDir }) => {
      const agentId = "test-agent";
      const canonicalRoot = path.join(stateDir, "agents", agentId);
      const agentDir = path.join(canonicalRoot, "agent");
      await fs.promises.mkdir(agentDir, { recursive: true });
      // Simulate post-deletion with residual content (e.g. leftover files).
      await fs.promises.writeFile(path.join(canonicalRoot, "orphan.txt"), "stale");

      await removeEmptyAgentParentDir({ agentDir, agentId, stateDir });

      // The non-empty parent must be preserved.
      await expect(fs.promises.access(canonicalRoot)).resolves.toBeUndefined();
      const entries = await fs.promises.readdir(canonicalRoot);
      expect(entries).toContain("orphan.txt");
    });
  });

  it("preserves a parent directory that was repopulated after subdirectory cleanup", async () => {
    await withStateDirEnv("openclaw-agent-parent-repop-", async ({ stateDir }) => {
      const agentId = "test-agent";
      const canonicalRoot = path.join(stateDir, "agents", agentId);
      const agentDir = path.join(canonicalRoot, "agent");
      await fs.promises.mkdir(agentDir, { recursive: true });
      // Simulate post-deletion state: subdirectory trashed, then a same-id
      // recreation repopulates the parent with a new sessions/ directory
      // before rmdir runs.
      await fs.promises.rmdir(agentDir);
      await fs.promises.mkdir(path.join(canonicalRoot, "sessions"), { recursive: true });

      await removeEmptyAgentParentDir({ agentDir, agentId, stateDir });

      // rmdir is atomic: ENOTEMPTY preserves the repopulated directory.
      await expect(fs.promises.access(canonicalRoot)).resolves.toBeUndefined();
      const entries = await fs.promises.readdir(canonicalRoot);
      expect(entries).toContain("sessions");
    });
  });

  it("preserves a custom agentDir parent outside the canonical root", async () => {
    await withStateDirEnv("openclaw-agent-parent-custom-", async ({ stateDir }) => {
      const agentId = "test-agent";
      const customAgentDir = "/tmp/openclaw-custom-agentdir-test";
      const customParent = path.dirname(customAgentDir);
      await fs.promises.mkdir(customAgentDir, { recursive: true });

      try {
        await removeEmptyAgentParentDir({ agentDir: customAgentDir, agentId, stateDir });

        // A custom agentDir parent must never be touched, even when empty.
        await expect(fs.promises.access(customAgentDir)).resolves.toBeUndefined();
        await expect(fs.promises.access(customParent)).resolves.toBeUndefined();
      } finally {
        await fs.promises.rm(customParent, { recursive: true, force: true });
      }
    });
  });

  it("does not throw when the canonical parent is already missing", async () => {
    await withStateDirEnv("openclaw-agent-parent-missing-", async ({ stateDir }) => {
      const agentId = "ghost-agent";
      const agentDir = path.join(stateDir, "agents", agentId, "agent");
      // Never create anything — the parent directory does not exist.

      await expect(
        removeEmptyAgentParentDir({ agentDir, agentId, stateDir }),
      ).resolves.toBeUndefined();
    });
  });

  it("does not throw when the canonical parent directory is not accessible", async () => {
    await withStateDirEnv("openclaw-agent-parent-denied-", async ({ stateDir }) => {
      const agentId = "test-agent";
      const canonicalRoot = path.join(stateDir, "agents", agentId);
      const agentDir = path.join(canonicalRoot, "agent");
      await fs.promises.mkdir(agentDir, { recursive: true });
      // Simulate post-deletion: subdirectory trashed.
      await fs.promises.rmdir(agentDir);
      // Remove write permission on the parent so rmdir fails with EACCES.
      await fs.promises.chmod(canonicalRoot, 0o500);
      try {
        await expect(
          removeEmptyAgentParentDir({ agentDir, agentId, stateDir }),
        ).resolves.toBeUndefined();
      } finally {
        await fs.promises.chmod(canonicalRoot, 0o700);
      }
    });
  });
});
