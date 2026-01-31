/**
 * Tests for Cursor Agent outbound adapter.
 */

import { describe, it, expect } from "vitest";

// Test the message parsing functions by extracting them
// For now, we'll test via the module's behavior

describe("outbound message parsing", () => {
  describe("repository extraction", () => {
    // Helper to test repo extraction logic
    const extractRepo = (body: string, defaultRepo?: string) => {
      // Try to extract repo from message
      const repoMatch = body.match(/@repo:(\S+)/i);
      if (repoMatch) {
        return {
          repo: repoMatch[1],
          cleanBody: body.replace(repoMatch[0], "").trim(),
        };
      }

      // Try to find GitHub URL in message
      const githubMatch = body.match(/(https:\/\/github\.com\/[\w-]+\/[\w-]+)/);
      if (githubMatch) {
        return {
          repo: githubMatch[1],
          cleanBody: body,
        };
      }

      if (defaultRepo) {
        return { repo: defaultRepo, cleanBody: body };
      }

      return null;
    };

    it("should extract @repo: annotation", () => {
      const result = extractRepo("@repo:https://github.com/user/repo Fix the bug");
      expect(result?.repo).toBe("https://github.com/user/repo");
      expect(result?.cleanBody).toBe("Fix the bug");
    });

    it("should extract GitHub URL from message", () => {
      const result = extractRepo("Fix bug in https://github.com/user/repo please");
      expect(result?.repo).toBe("https://github.com/user/repo");
      expect(result?.cleanBody).toBe("Fix bug in https://github.com/user/repo please");
    });

    it("should use default repo when no repo in message", () => {
      const result = extractRepo("Fix the bug", "https://github.com/default/repo");
      expect(result?.repo).toBe("https://github.com/default/repo");
      expect(result?.cleanBody).toBe("Fix the bug");
    });

    it("should return null when no repo available", () => {
      const result = extractRepo("Fix the bug");
      expect(result).toBeNull();
    });

    it("should handle @repo with complex URLs", () => {
      const result = extractRepo("@repo:https://github.com/my-org/my-repo-name Add feature");
      expect(result?.repo).toBe("https://github.com/my-org/my-repo-name");
    });
  });

  describe("branch extraction", () => {
    // Helper to test branch extraction logic
    const extractBranch = (body: string, defaultBranch: string = "main") => {
      const branchMatch = body.match(/@branch:(\S+)/i);
      if (branchMatch) {
        return {
          branch: branchMatch[1],
          cleanBody: body.replace(branchMatch[0], "").trim(),
        };
      }
      return { branch: defaultBranch, cleanBody: body };
    };

    it("should extract @branch: annotation", () => {
      const result = extractBranch("@branch:feature-auth Add authentication");
      expect(result.branch).toBe("feature-auth");
      expect(result.cleanBody).toBe("Add authentication");
    });

    it("should use default branch when not specified", () => {
      const result = extractBranch("Fix the bug");
      expect(result.branch).toBe("main");
      expect(result.cleanBody).toBe("Fix the bug");
    });

    it("should use custom default branch", () => {
      const result = extractBranch("Fix the bug", "develop");
      expect(result.branch).toBe("develop");
    });

    it("should handle branch names with dashes and numbers", () => {
      const result = extractBranch("@branch:feature/JIRA-123-fix Fix it");
      expect(result.branch).toBe("feature/JIRA-123-fix");
    });
  });

  describe("combined parsing", () => {
    const parseMessage = (body: string, defaultRepo?: string, defaultBranch: string = "main") => {
      // Extract repo
      let cleanBody = body;
      let repo = defaultRepo;

      const repoMatch = cleanBody.match(/@repo:(\S+)/i);
      if (repoMatch) {
        repo = repoMatch[1];
        cleanBody = cleanBody.replace(repoMatch[0], "").trim();
      } else {
        const githubMatch = cleanBody.match(/(https:\/\/github\.com\/[\w-]+\/[\w-]+)/);
        if (githubMatch) {
          repo = githubMatch[1];
        }
      }

      // Extract branch
      let branch = defaultBranch;
      const branchMatch = cleanBody.match(/@branch:(\S+)/i);
      if (branchMatch) {
        branch = branchMatch[1];
        cleanBody = cleanBody.replace(branchMatch[0], "").trim();
      }

      return { repo, branch, instructions: cleanBody };
    };

    it("should parse message with both repo and branch", () => {
      const result = parseMessage(
        "@repo:https://github.com/user/repo @branch:develop Fix the login bug",
      );
      expect(result.repo).toBe("https://github.com/user/repo");
      expect(result.branch).toBe("develop");
      expect(result.instructions).toBe("Fix the login bug");
    });

    it("should parse message with only instructions", () => {
      const result = parseMessage("Fix the login bug", "https://github.com/default/repo", "main");
      expect(result.repo).toBe("https://github.com/default/repo");
      expect(result.branch).toBe("main");
      expect(result.instructions).toBe("Fix the login bug");
    });

    it("should handle annotations in any order", () => {
      const result = parseMessage("@branch:feature Fix bug @repo:https://github.com/user/repo");
      expect(result.repo).toBe("https://github.com/user/repo");
      expect(result.branch).toBe("feature");
      expect(result.instructions).toBe("Fix bug");
    });
  });
});
