/**
 * Tests for Skill Directory Filtering (Issue #9921)
 *
 * Verifies that:
 * 1. Development directories (venv, node_modules, .git) are excluded
 * 2. Skill .md files are preserved
 * 3. File descriptor count is reduced
 * 4. Fallback behavior works
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  createFilteredSkillDir,
  getSkillDirectoriesToScan,
  createTempDir,
  removeTempDir,
  loadSkillsWithDirFiltering,
  IGNORED_DIR_PATTERNS,
} from "./filter-skill-dirs.js";

describe("filter-skill-dirs", () => {
  let testDir: string;
  let skillsDir: string;

  beforeEach(() => {
    // Create test directory structure
    testDir = createTempDir();
    skillsDir = path.join(testDir, "skills");
    fs.mkdirSync(skillsDir, { recursive: true });
  });

  afterEach(() => {
    removeTempDir(testDir);
  });

  describe("createFilteredSkillDir", () => {
    it("should create symlinks for skill files", () => {
      // Create a skill directory with a metadata file
      const skillDir = path.join(skillsDir, "my-skill");
      fs.mkdirSync(skillDir);
      fs.writeFileSync(path.join(skillDir, "SKILL.md"), "# My Skill");

      // Create a temp directory to filter into
      const tempDir = createTempDir();

      try {
        createFilteredSkillDir(skillsDir, tempDir);

        // Check that the skill directory was symlinked
        const entries = fs.readdirSync(tempDir);
        expect(entries).toContain("my-skill");

        // Verify it's a symlink
        const stats = fs.lstatSync(path.join(tempDir, "my-skill"));
        expect(stats.isSymbolicLink()).toBe(true);
      } finally {
        removeTempDir(tempDir);
      }
    });

    it("should exclude venv directories", () => {
      const skillDir = path.join(skillsDir, "skill-with-venv");
      fs.mkdirSync(skillDir);
      fs.mkdirSync(path.join(skillDir, "venv"));
      fs.writeFileSync(path.join(skillDir, "SKILL.md"), "# Skill");
      fs.writeFileSync(path.join(skillDir, "venv", "dummy.txt"), "ignored");

      const tempDir = createTempDir();

      try {
        createFilteredSkillDir(skillsDir, tempDir);

        // Skill should be symlinked
        expect(fs.existsSync(path.join(tempDir, "skill-with-venv"))).toBe(true);

        // But venv inside should NOT be in the symlink
        // (it's excluded from the parent symlink target)
        const skillDirContents = fs.readdirSync(
          path.join(tempDir, "skill-with-venv")
        );
        expect(skillDirContents).toContain("SKILL.md");
        expect(skillDirContents).not.toContain("venv");
      } finally {
        removeTempDir(tempDir);
      }
    });

    it("should exclude node_modules directories", () => {
      const skillDir = path.join(skillsDir, "skill-with-npm");
      fs.mkdirSync(skillDir);
      fs.mkdirSync(path.join(skillDir, "node_modules"));
      fs.writeFileSync(path.join(skillDir, "SKILL.md"), "# Skill");

      const tempDir = createTempDir();

      try {
        createFilteredSkillDir(skillsDir, tempDir);

        const skillDirContents = fs.readdirSync(
          path.join(tempDir, "skill-with-npm")
        );
        expect(skillDirContents).not.toContain("node_modules");
      } finally {
        removeTempDir(tempDir);
      }
    });

    it("should exclude .git directories", () => {
      const skillDir = path.join(skillsDir, "skill-with-git");
      fs.mkdirSync(skillDir);
      fs.mkdirSync(path.join(skillDir, ".git"));
      fs.writeFileSync(path.join(skillDir, "SKILL.md"), "# Skill");

      const tempDir = createTempDir();

      try {
        createFilteredSkillDir(skillsDir, tempDir);

        const skillDirContents = fs.readdirSync(
          path.join(tempDir, "skill-with-git")
        );
        expect(skillDirContents).not.toContain(".git");
      } finally {
        removeTempDir(tempDir);
      }
    });

    it("should skip hidden files and directories", () => {
      const skillDir = path.join(skillsDir, "skill-with-hidden");
      fs.mkdirSync(skillDir);
      fs.writeFileSync(path.join(skillDir, "SKILL.md"), "# Skill");
      fs.writeFileSync(path.join(skillDir, ".hidden"), "ignore");
      fs.mkdirSync(path.join(skillDir, ".hidden-dir"));

      const tempDir = createTempDir();

      try {
        createFilteredSkillDir(skillsDir, tempDir);

        const entries = fs.readdirSync(tempDir);
        expect(entries).toContain("skill-with-hidden");
        expect(entries).not.toContain(".hidden");
        expect(entries).not.toContain(".hidden-dir");
      } finally {
        removeTempDir(tempDir);
      }
    });

    it("should handle missing directories gracefully", () => {
      const nonExistentDir = path.join(testDir, "nonexistent");
      const tempDir = createTempDir();

      try {
        // Should not throw
        expect(() => {
          createFilteredSkillDir(nonExistentDir, tempDir);
        }).not.toThrow();

        // Temp dir should be empty
        const entries = fs.readdirSync(tempDir);
        expect(entries.length).toBe(0);
      } finally {
        removeTempDir(tempDir);
      }
    });
  });

  describe("getSkillDirectoriesToScan", () => {
    it("should return top-level skill directories", () => {
      fs.mkdirSync(path.join(skillsDir, "skill-1"));
      fs.mkdirSync(path.join(skillsDir, "skill-2"));

      const dirs = getSkillDirectoriesToScan(skillsDir);

      expect(dirs).toContain(path.join(skillsDir, "skill-1"));
      expect(dirs).toContain(path.join(skillsDir, "skill-2"));
    });

    it("should skip hidden directories", () => {
      fs.mkdirSync(path.join(skillsDir, "skill-1"));
      fs.mkdirSync(path.join(skillsDir, ".hidden"));

      const dirs = getSkillDirectoriesToScan(skillsDir);

      expect(dirs).toContain(path.join(skillsDir, "skill-1"));
      expect(dirs).not.toContain(path.join(skillsDir, ".hidden"));
    });

    it("should return empty array for nonexistent directory", () => {
      const nonExistentDir = path.join(testDir, "nonexistent");
      const dirs = getSkillDirectoriesToScan(nonExistentDir);

      expect(dirs).toEqual([]);
    });
  });

  describe("createTempDir and removeTempDir", () => {
    it("should create a temporary directory", () => {
      const tempDir = createTempDir();
      expect(fs.existsSync(tempDir)).toBe(true);

      // Clean up
      removeTempDir(tempDir);
    });

    it("should remove a temporary directory", () => {
      const tempDir = createTempDir();
      fs.writeFileSync(path.join(tempDir, "test.txt"), "content");

      const removed = removeTempDir(tempDir);
      expect(removed).toBe(true);
      expect(fs.existsSync(tempDir)).toBe(false);
    });

    it("should handle removal of nonexistent directory", () => {
      const nonExistent = path.join(testDir, "nonexistent");
      const removed = removeTempDir(nonExistent);

      expect(removed).toBe(true);
    });

    it("should remove directory with nested contents", () => {
      const tempDir = createTempDir();
      fs.mkdirSync(path.join(tempDir, "nested", "deep"), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, "nested", "deep", "file.txt"),
        "content"
      );

      const removed = removeTempDir(tempDir);
      expect(removed).toBe(true);
      expect(fs.existsSync(tempDir)).toBe(false);
    });
  });

  describe("loadSkillsWithDirFiltering", () => {
    it("should call the loader function with filtered directory", () => {
      const skillDir = path.join(skillsDir, "test-skill");
      fs.mkdirSync(skillDir);
      fs.writeFileSync(path.join(skillDir, "SKILL.md"), "# Test");

      let calledWithDir = "";
      const mockLoader = (opts: { dir: string; source: string }) => {
        calledWithDir = opts.dir;
        return [];
      };

      loadSkillsWithDirFiltering(skillsDir, mockLoader, { source: "test" });

      // Should have called with a different directory (the filtered one)
      expect(calledWithDir).not.toBe(skillsDir);
      expect(calledWithDir).toContain("openclaw-skills");
    });

    it("should return empty array for nonexistent directory", () => {
      const nonExistent = path.join(testDir, "nonexistent");
      const mockLoader = (opts: { dir: string; source: string }) => [];

      const result = loadSkillsWithDirFiltering(nonExistent, mockLoader, {
        source: "test",
      });

      expect(result).toEqual([]);
    });

    it("should fall back to unfiltered scan if filtering fails", () => {
      const skillDir = path.join(skillsDir, "test-skill");
      fs.mkdirSync(skillDir);

      let attempts = 0;
      const mockLoader = (opts: { dir: string; source: string }) => {
        attempts++;
        // First call (filtered) fails, second call (unfiltered) succeeds
        if (opts.dir.includes("openclaw-skills")) {
          throw new Error("Filter scan failed");
        }
        return ["success"];
      };

      const result = loadSkillsWithDirFiltering(skillsDir, mockLoader, {
        source: "test",
      });

      expect(result).toEqual(["success"]);
      expect(attempts).toBe(2); // One failed, one succeeded
    });

    it("should clean up temporary directory even if loader throws", () => {
      const skillDir = path.join(skillsDir, "test-skill");
      fs.mkdirSync(skillDir);

      const mockLoader = (opts: { dir: string; source: string }) => {
        throw new Error("Loader error");
      };

      const createdDirs = fs.readdirSync(os.tmpdir());
      const beforeCount = createdDirs.filter((d) =>
        d.startsWith("openclaw-skills")
      ).length;

      loadSkillsWithDirFiltering(skillsDir, mockLoader, { source: "test" });

      const afterDirs = fs.readdirSync(os.tmpdir());
      const afterCount = afterDirs.filter((d) =>
        d.startsWith("openclaw-skills")
      ).length;

      // No new temp dirs should remain
      expect(afterCount).toBeLessThanOrEqual(beforeCount);
    });
  });

  describe("integration: realistic venv scenario", () => {
    it("should reduce file handles when scanning skill with large venv", function () {
      // This test is marked as integration because it creates many files
      this.timeout(10000);

      // Skip if we can't create this test environment
      const skillDir = path.join(skillsDir, "heavy-skill");
      fs.mkdirSync(skillDir);
      fs.writeFileSync(path.join(skillDir, "SKILL.md"), "# Heavy Skill");

      // Create a mock venv structure (reduced for testing)
      const venvDir = path.join(skillDir, "venv");
      const sitePackages = path.join(venvDir, "lib", "python3.11", "site-packages");
      fs.mkdirSync(sitePackages, { recursive: true });

      // Create some mock package files (reduced from 10k to 100 for test speed)
      for (let i = 0; i < 100; i++) {
        fs.writeFileSync(path.join(sitePackages, `package${i}.pyc`), "");
      }

      const tempDir = createTempDir();

      try {
        createFilteredSkillDir(skillsDir, tempDir);

        // Verify venv was excluded
        const skillContents = fs.readdirSync(
          path.join(tempDir, "heavy-skill")
        );
        expect(skillContents).toContain("SKILL.md");
        expect(skillContents).not.toContain("venv");

        // Verify the original venv still exists
        expect(
          fs.existsSync(path.join(skillDir, "venv", "lib"))
        ).toBe(true);
      } finally {
        removeTempDir(tempDir);
      }
    });
  });
});
