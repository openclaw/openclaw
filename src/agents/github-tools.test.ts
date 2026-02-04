import { describe, it, expect, vi, beforeEach } from "vitest";
import { createGitHubTools, type GitHubToolsConfig } from "./github-tools.js";

describe("GitHub Tools", () => {
  let mockExecFn: ReturnType<typeof vi.fn>;
  let config: GitHubToolsConfig;

  beforeEach(() => {
    mockExecFn = vi.fn();
    config = {
      execFn: mockExecFn,
      defaults: {
        baseBranch: "main",
        mergeStrategy: "squash",
        autoDeleteBranch: true,
        workdir: "/test/workspace",
      },
    };
  });

  describe("createPR", () => {
    it("should create PR with all required parameters", async () => {
      mockExecFn.mockResolvedValue({
        stdout: "https://github.com/owner/repo/pull/42\n",
        stderr: "",
        exitCode: 0,
      });

      const tools = createGitHubTools(config);
      const result = await tools.createPR.execute(
        "test-call-id",
        {
          title: "feat: new feature",
          body: "PR description",
          head: "feature-branch",
          base: "main",
        },
        undefined,
        undefined,
      );

      expect(mockExecFn).toHaveBeenCalledWith({
        command: expect.stringContaining("gh pr create"),
        workdir: config.defaults?.workdir,
        timeout: 30,
      });

      expect(result.content[0]).toMatchObject({
        type: "text",
        text: expect.stringContaining("#42"),
      });

      expect(result.details).toMatchObject({
        status: "created",
        prNumber: 42,
        prUrl: "https://github.com/owner/repo/pull/42",
        title: "feat: new feature",
        base: "main",
        head: "feature-branch",
      });
    });

    it("should handle draft PRs", async () => {
      mockExecFn.mockResolvedValue({
        stdout: "https://github.com/owner/repo/pull/43\n",
        stderr: "",
        exitCode: 0,
      });

      const tools = createGitHubTools(config);
      await tools.createPR.execute(
        "test-call-id",
        {
          title: "WIP: draft feature",
          body: "Work in progress",
          head: "draft-branch",
          draft: true,
        },
        undefined,
        undefined,
      );

      expect(mockExecFn).toHaveBeenCalledWith({
        command: expect.stringContaining("--draft"),
        workdir: config.defaults?.workdir,
        timeout: 30,
      });
    });

    it("should handle PR creation failure", async () => {
      mockExecFn.mockResolvedValue({
        stdout: "",
        stderr: "fatal: not a git repository",
        exitCode: 1,
      });

      const tools = createGitHubTools(config);

      await expect(
        tools.createPR.execute(
          "test-call-id",
          {
            title: "feat: test",
            body: "Test",
            head: "test-branch",
          },
          undefined,
          undefined,
        ),
      ).rejects.toThrow("GitHub PR creation failed");
    });

    it("should escape special characters in title", async () => {
      mockExecFn.mockResolvedValue({
        stdout: "https://github.com/owner/repo/pull/44\n",
        stderr: "",
        exitCode: 0,
      });

      const tools = createGitHubTools(config);
      await tools.createPR.execute(
        "test-call-id",
        {
          title: 'feat: "quoted" title',
          body: "Test body",
          head: "test-branch",
        },
        undefined,
        undefined,
      );

      expect(mockExecFn).toHaveBeenCalledWith({
        command: expect.stringContaining('\\"quoted\\"'),
        workdir: config.defaults?.workdir,
        timeout: 30,
      });
    });
  });

  describe("reviewPR", () => {
    it("should approve PR with review body", async () => {
      mockExecFn.mockResolvedValue({
        stdout: "",
        stderr: "",
        exitCode: 0,
      });

      const tools = createGitHubTools(config);
      const result = await tools.reviewPR.execute(
        "test-call-id",
        {
          prNumber: 42,
          action: "approve",
          body: "LGTM! All tests pass.",
        },
        undefined,
        undefined,
      );

      expect(mockExecFn).toHaveBeenCalledWith({
        command: expect.stringContaining("gh pr review 42 --approve"),
        workdir: config.defaults?.workdir,
        timeout: 30,
      });

      expect(result.details).toMatchObject({
        status: "approved",
        prNumber: 42,
        body: "LGTM! All tests pass.",
      });
    });

    it("should request changes with feedback", async () => {
      mockExecFn.mockResolvedValue({
        stdout: "",
        stderr: "",
        exitCode: 0,
      });

      const tools = createGitHubTools(config);
      const result = await tools.reviewPR.execute(
        "test-call-id",
        {
          prNumber: 42,
          action: "request-changes",
          body: "Please fix the failing tests.",
        },
        undefined,
        undefined,
      );

      expect(mockExecFn).toHaveBeenCalledWith({
        command: expect.stringContaining("gh pr review 42 --request-changes"),
        workdir: config.defaults?.workdir,
        timeout: 30,
      });

      expect(result.details).toMatchObject({
        status: "changes-requested",
        prNumber: 42,
      });
    });

    it("should post comment without explicit approval", async () => {
      mockExecFn.mockResolvedValue({
        stdout: "",
        stderr: "",
        exitCode: 0,
      });

      const tools = createGitHubTools(config);
      const result = await tools.reviewPR.execute(
        "test-call-id",
        {
          prNumber: 42,
          action: "comment",
          body: "Looks good, but please add more tests.",
        },
        undefined,
        undefined,
      );

      expect(mockExecFn).toHaveBeenCalledWith({
        command: expect.stringContaining("gh pr review 42 --comment"),
        workdir: config.defaults?.workdir,
        timeout: 30,
      });

      expect(result.details).toMatchObject({
        status: "commented",
        prNumber: 42,
      });
    });
  });

  describe("mergePR", () => {
    it("should merge PR with squash strategy", async () => {
      mockExecFn.mockResolvedValue({
        stdout: "Pull request #42 merged (abc123def)\n",
        stderr: "",
        exitCode: 0,
      });

      const tools = createGitHubTools(config);
      const result = await tools.mergePR.execute(
        "test-call-id",
        {
          prNumber: 42,
          strategy: "squash",
          deleteBranch: true,
        },
        undefined,
        undefined,
      );

      expect(mockExecFn).toHaveBeenCalledWith({
        command: expect.stringContaining("gh pr merge 42 --squash --delete-branch"),
        workdir: config.defaults?.workdir,
        timeout: 60,
      });

      expect(result.details).toMatchObject({
        status: "merged",
        prNumber: 42,
        sha: "abc123def",
      });
    });

    it("should enable auto-merge", async () => {
      mockExecFn.mockResolvedValue({
        stdout: "Auto-merge enabled for pull request #42\n",
        stderr: "",
        exitCode: 0,
      });

      const tools = createGitHubTools(config);
      await tools.mergePR.execute(
        "test-call-id",
        {
          prNumber: 42,
          auto: true,
        },
        undefined,
        undefined,
      );

      expect(mockExecFn).toHaveBeenCalledWith({
        command: expect.stringContaining("gh pr merge 42 --squash --auto --delete-branch"),
        workdir: config.defaults?.workdir,
        timeout: 60,
      });
    });

    it("should handle merge conflicts", async () => {
      mockExecFn.mockResolvedValue({
        stdout: "",
        stderr: "pull request merge failed: merge conflict",
        exitCode: 1,
      });

      const tools = createGitHubTools(config);
      const result = await tools.mergePR.execute(
        "test-call-id",
        {
          prNumber: 42,
        },
        undefined,
        undefined,
      );

      expect(result.details).toMatchObject({
        status: "failed",
        prNumber: 42,
        message: expect.stringContaining("merge conflict"),
      });
    });

    it("should use rebase strategy when specified", async () => {
      mockExecFn.mockResolvedValue({
        stdout: "Pull request #42 merged\n",
        stderr: "",
        exitCode: 0,
      });

      const tools = createGitHubTools(config);
      await tools.mergePR.execute(
        "test-call-id",
        {
          prNumber: 42,
          strategy: "rebase",
        },
        undefined,
        undefined,
      );

      expect(mockExecFn).toHaveBeenCalledWith({
        command: expect.stringContaining("--rebase"),
        workdir: config.defaults?.workdir,
        timeout: 60,
      });
    });

    it("should preserve branch when deleteBranch is false", async () => {
      mockExecFn.mockResolvedValue({
        stdout: "Pull request #42 merged\n",
        stderr: "",
        exitCode: 0,
      });

      const tools = createGitHubTools(config);
      await tools.mergePR.execute(
        "test-call-id",
        {
          prNumber: 42,
          deleteBranch: false,
        },
        undefined,
        undefined,
      );

      expect(mockExecFn).toHaveBeenCalledWith({
        command: expect.not.stringContaining("--delete-branch"),
        workdir: config.defaults?.workdir,
        timeout: 60,
      });
    });
  });

  describe("getPRInfo", () => {
    it("should fetch PR details as JSON", async () => {
      const prData = {
        number: 42,
        title: "feat: new feature",
        body: "PR description",
        state: "OPEN",
        baseRefName: "main",
        headRefName: "feature-branch",
        author: { login: "agent-a" },
        reviewDecision: "APPROVED",
        mergeable: "MERGEABLE",
        url: "https://github.com/owner/repo/pull/42",
      };

      mockExecFn.mockResolvedValue({
        stdout: JSON.stringify(prData),
        stderr: "",
        exitCode: 0,
      });

      const tools = createGitHubTools(config);
      const result = await tools.getPRInfo.execute(
        "test-call-id",
        {
          prNumber: 42,
        },
        undefined,
        undefined,
      );

      expect(mockExecFn).toHaveBeenCalledWith({
        command: expect.stringContaining("gh pr view 42 --json"),
        workdir: config.defaults?.workdir,
        timeout: 30,
      });

      expect(result.details).toMatchObject({
        status: "open",
        prNumber: 42,
        title: "feat: new feature",
        base: "main",
        head: "feature-branch",
        author: "agent-a",
        reviewDecision: "APPROVED",
        mergeable: "MERGEABLE",
      });
    });

    it("should handle merged PRs", async () => {
      const prData = {
        number: 42,
        title: "feat: merged feature",
        body: "Merged PR",
        state: "MERGED",
        baseRefName: "main",
        headRefName: "feature-branch",
        author: { login: "agent-a" },
        url: "https://github.com/owner/repo/pull/42",
      };

      mockExecFn.mockResolvedValue({
        stdout: JSON.stringify(prData),
        stderr: "",
        exitCode: 0,
      });

      const tools = createGitHubTools(config);
      const result = await tools.getPRInfo.execute(
        "test-call-id",
        {
          prNumber: 42,
        },
        undefined,
        undefined,
      );

      expect(result.details?.status).toBe("merged");
    });

    it("should handle closed PRs", async () => {
      const prData = {
        number: 42,
        title: "feat: closed feature",
        body: "Closed PR",
        state: "CLOSED",
        baseRefName: "main",
        headRefName: "feature-branch",
        author: { login: "agent-a" },
        url: "https://github.com/owner/repo/pull/42",
      };

      mockExecFn.mockResolvedValue({
        stdout: JSON.stringify(prData),
        stderr: "",
        exitCode: 0,
      });

      const tools = createGitHubTools(config);
      const result = await tools.getPRInfo.execute(
        "test-call-id",
        {
          prNumber: 42,
        },
        undefined,
        undefined,
      );

      expect(result.details?.status).toBe("closed");
    });
  });

  describe("commentPR", () => {
    it("should add comment to PR", async () => {
      mockExecFn.mockResolvedValue({
        stdout: "",
        stderr: "",
        exitCode: 0,
      });

      const tools = createGitHubTools(config);
      const result = await tools.commentPR.execute(
        "test-call-id",
        {
          prNumber: 42,
          body: "Running tests now...",
        },
        undefined,
        undefined,
      );

      expect(mockExecFn).toHaveBeenCalledWith({
        command: expect.stringContaining("gh pr comment 42"),
        workdir: config.defaults?.workdir,
        timeout: 30,
      });

      expect(result.details).toMatchObject({
        status: "commented",
        prNumber: 42,
      });
    });

    it("should handle multiline comments", async () => {
      mockExecFn.mockResolvedValue({
        stdout: "",
        stderr: "",
        exitCode: 0,
      });

      const tools = createGitHubTools(config);
      const multilineComment = "## Review Status\n\n- Tests: Running\n- Lint: Pending";

      await tools.commentPR.execute(
        "test-call-id",
        {
          prNumber: 42,
          body: multilineComment,
        },
        undefined,
        undefined,
      );

      expect(mockExecFn).toHaveBeenCalledWith({
        command: expect.stringContaining(multilineComment),
        workdir: config.defaults?.workdir,
        timeout: 30,
      });
    });
  });
});
