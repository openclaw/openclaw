import { Type } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import type { ExecToolDefaults } from "./bash-tools.exec.js";

// GitHub tool result types
export type GitHubPRDetails = {
  status: "created" | "found";
  prNumber: number;
  prUrl: string;
  title: string;
  base: string;
  head: string;
};

export type GitHubReviewDetails = {
  status: "approved" | "changes-requested" | "commented";
  prNumber: number;
  reviewId?: string;
  body: string;
};

export type GitHubMergeDetails = {
  status: "merged" | "failed";
  prNumber: number;
  sha?: string;
  message?: string;
};

export type GitHubPRInfoDetails = {
  status: "open" | "closed" | "merged";
  prNumber: number;
  title: string;
  body: string;
  base: string;
  head: string;
  author: string;
  reviewDecision?: string;
  mergeable?: string;
  url: string;
};

type GitHubExecFn = (args: {
  command: string;
  workdir?: string;
  env?: Record<string, string>;
  timeout?: number;
}) => Promise<{ stdout: string; stderr: string; exitCode: number | null }>;

// Helper to extract PR number from gh CLI output
function extractPRNumber(output: string): number | null {
  // Look for PR URL pattern: https://github.com/owner/repo/pull/123
  const urlMatch = output.match(/https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)/);
  if (urlMatch?.[1]) {
    return Number.parseInt(urlMatch[1], 10);
  }

  // Look for plain number after "pull request" or "PR"
  const prMatch = output.match(/(?:pull request|PR)\s+#?(\d+)/i);
  if (prMatch?.[1]) {
    return Number.parseInt(prMatch[1], 10);
  }

  return null;
}

// Helper to build heredoc command for gh CLI (avoids shell escaping issues)
function buildGhCommand(baseCmd: string, bodyContent: string): string {
  return `${baseCmd} --body "$(cat <<'EOF'
${bodyContent.trim()}
EOF
)"`;
}

export type GitHubToolsConfig = {
  execFn: GitHubExecFn;
  defaults?: {
    repo?: string;
    baseBranch?: string;
    workdir?: string;
    mergeStrategy?: "squash" | "merge" | "rebase";
    autoDeleteBranch?: boolean;
  };
};

export function createGitHubTools(config: GitHubToolsConfig): {
  createPR: AgentTool<unknown, GitHubPRDetails>;
  reviewPR: AgentTool<unknown, GitHubReviewDetails>;
  mergePR: AgentTool<unknown, GitHubMergeDetails>;
  getPRInfo: AgentTool<unknown, GitHubPRInfoDetails>;
  commentPR: AgentTool<unknown, { status: "commented"; prNumber: number }>;
} {
  const { execFn, defaults } = config;

  // Tool: Create Pull Request
  const createPR: AgentTool<unknown, GitHubPRDetails> = {
    name: "github_create_pr",
    label: "github_create_pr",
    description:
      "Create a GitHub pull request. Returns PR number and URL. Always provide complete parameters to avoid interactive prompts.",
    parameters: Type.Object({
      title: Type.String({ description: "PR title (concise, under 70 chars)" }),
      body: Type.String({ description: "PR description/summary (markdown supported)" }),
      head: Type.String({
        description: "Source branch name (e.g., feature-branch, agent-a-changes)",
      }),
      base: Type.Optional(
        Type.String({ description: "Target branch (defaults to main or config default)" }),
      ),
      repo: Type.Optional(
        Type.String({ description: "Repository in owner/repo format (defaults to current repo)" }),
      ),
      workdir: Type.Optional(
        Type.String({ description: "Working directory (defaults to current directory)" }),
      ),
      draft: Type.Optional(Type.Boolean({ description: "Create as draft PR (defaults to false)" })),
    }),
    execute: async (_toolCallId, args) => {
      const params = args as {
        title: string;
        body: string;
        head: string;
        base?: string;
        repo?: string;
        workdir?: string;
        draft?: boolean;
      };

      const baseBranch = params.base || defaults?.baseBranch || "main";
      const workdir = params.workdir || defaults?.workdir;

      // Build gh pr create command with all required parameters
      let command = `gh pr create --base ${baseBranch} --head ${params.head} --title "${params.title.replace(/"/g, '\\"')}"`;

      // Add body via heredoc to avoid escaping issues
      command = buildGhCommand(command, params.body);

      // Add optional parameters
      if (params.repo) {
        command += ` --repo ${params.repo}`;
      }
      if (params.draft) {
        command += " --draft";
      }
      command += " --no-maintainer-edit"; // Prevent interactive prompts

      try {
        const result = await execFn({ command, workdir, timeout: 30 });

        if (result.exitCode !== 0) {
          throw new Error(
            `Failed to create PR: ${result.stderr || result.stdout || "Unknown error"}`,
          );
        }

        const output = result.stdout.trim();
        const prNumber = extractPRNumber(output);

        if (!prNumber) {
          throw new Error(`Could not extract PR number from output: ${output}`);
        }

        // Extract PR URL (gh pr create returns the URL)
        const prUrl = output.split("\n").find((line) => line.includes("github.com/")) || output;

        return {
          content: [
            {
              type: "text",
              text: `✓ Pull request created: #${prNumber}\n\n${prUrl}\n\nTitle: ${params.title}\nBase: ${baseBranch} ← Head: ${params.head}`,
            },
          ],
          details: {
            status: "created",
            prNumber,
            prUrl: prUrl.trim(),
            title: params.title,
            base: baseBranch,
            head: params.head,
          },
        };
      } catch (err) {
        throw new Error(`GitHub PR creation failed: ${String(err)}`);
      }
    },
  };

  // Tool: Review Pull Request
  const reviewPR: AgentTool<unknown, GitHubReviewDetails> = {
    name: "github_review_pr",
    label: "github_review_pr",
    description:
      "Review a GitHub pull request (approve, request changes, or comment). Use after analyzing PR code changes.",
    parameters: Type.Object({
      prNumber: Type.Number({ description: "Pull request number" }),
      action: Type.String({
        description: "Review action: approve, request-changes, or comment",
        enum: ["approve", "request-changes", "comment"],
      }),
      body: Type.String({ description: "Review comment/feedback (markdown supported)" }),
      repo: Type.Optional(
        Type.String({ description: "Repository in owner/repo format (defaults to current repo)" }),
      ),
      workdir: Type.Optional(
        Type.String({ description: "Working directory (defaults to current directory)" }),
      ),
    }),
    execute: async (_toolCallId, args) => {
      const params = args as {
        prNumber: number;
        action: "approve" | "request-changes" | "comment";
        body: string;
        repo?: string;
        workdir?: string;
      };

      const workdir = params.workdir || defaults?.workdir;

      // Map action to gh CLI flag
      const actionFlag =
        params.action === "approve"
          ? "--approve"
          : params.action === "request-changes"
            ? "--request-changes"
            : "--comment";

      // Build gh pr review command
      let command = `gh pr review ${params.prNumber} ${actionFlag}`;
      command = buildGhCommand(command, params.body);

      if (params.repo) {
        command += ` --repo ${params.repo}`;
      }

      try {
        const result = await execFn({ command, workdir, timeout: 30 });

        if (result.exitCode !== 0) {
          throw new Error(
            `Failed to review PR: ${result.stderr || result.stdout || "Unknown error"}`,
          );
        }

        const statusLabel =
          params.action === "approve"
            ? "✓ Approved"
            : params.action === "request-changes"
              ? "⚠ Changes Requested"
              : "💬 Commented";

        return {
          content: [
            {
              type: "text",
              text: `${statusLabel} PR #${params.prNumber}\n\nReview:\n${params.body}`,
            },
          ],
          details: {
            status:
              params.action === "approve"
                ? "approved"
                : params.action === "request-changes"
                  ? "changes-requested"
                  : "commented",
            prNumber: params.prNumber,
            body: params.body,
          },
        };
      } catch (err) {
        throw new Error(`GitHub PR review failed: ${String(err)}`);
      }
    },
  };

  // Tool: Merge Pull Request
  const mergePR: AgentTool<unknown, GitHubMergeDetails> = {
    name: "github_merge_pr",
    label: "github_merge_pr",
    description:
      "Merge a GitHub pull request. Use after PR is approved and CI checks pass. Supports squash, merge, or rebase strategies.",
    parameters: Type.Object({
      prNumber: Type.Number({ description: "Pull request number" }),
      strategy: Type.Optional(
        Type.String({
          description: "Merge strategy: squash, merge, or rebase (defaults to squash)",
          enum: ["squash", "merge", "rebase"],
        }),
      ),
      deleteBranch: Type.Optional(
        Type.Boolean({
          description: "Delete branch after merge (defaults to true)",
        }),
      ),
      auto: Type.Optional(
        Type.Boolean({
          description:
            "Enable auto-merge (merge when CI passes, defaults to false). Use for async merging.",
        }),
      ),
      repo: Type.Optional(
        Type.String({ description: "Repository in owner/repo format (defaults to current repo)" }),
      ),
      workdir: Type.Optional(
        Type.String({ description: "Working directory (defaults to current directory)" }),
      ),
    }),
    execute: async (_toolCallId, args) => {
      const params = args as {
        prNumber: number;
        strategy?: "squash" | "merge" | "rebase";
        deleteBranch?: boolean;
        auto?: boolean;
        repo?: string;
        workdir?: string;
      };

      const workdir = params.workdir || defaults?.workdir;
      const strategy = params.strategy || defaults?.mergeStrategy || "squash";
      const deleteBranch = params.deleteBranch ?? defaults?.autoDeleteBranch ?? true;

      // Build gh pr merge command
      let command = `gh pr merge ${params.prNumber}`;

      // Add merge strategy
      if (strategy === "squash") {
        command += " --squash";
      } else if (strategy === "rebase") {
        command += " --rebase";
      } else {
        command += " --merge";
      }

      // Add auto-merge flag
      if (params.auto) {
        command += " --auto";
      }

      // Add delete-branch flag
      if (deleteBranch) {
        command += " --delete-branch";
      }

      if (params.repo) {
        command += ` --repo ${params.repo}`;
      }

      try {
        const result = await execFn({ command, workdir, timeout: 60 });

        if (result.exitCode !== 0) {
          throw new Error(
            `Failed to merge PR: ${result.stderr || result.stdout || "Unknown error"}`,
          );
        }

        const output = result.stdout.trim();
        const shaMatch = output.match(/([a-f0-9]{7,40})/);
        const sha = shaMatch?.[1];

        return {
          content: [
            {
              type: "text",
              text: params.auto
                ? `✓ Auto-merge enabled for PR #${params.prNumber}\n\nWill merge automatically when CI checks pass.`
                : `✓ Merged PR #${params.prNumber} using ${strategy} strategy${sha ? ` (${sha})` : ""}\n\n${output}`,
            },
          ],
          details: {
            status: "merged",
            prNumber: params.prNumber,
            sha: sha || undefined,
            message: output,
          },
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Failed to merge PR #${params.prNumber}: ${String(err)}`,
            },
          ],
          details: {
            status: "failed",
            prNumber: params.prNumber,
            message: String(err),
          },
        };
      }
    },
  };

  // Tool: Get PR Info
  const getPRInfo: AgentTool<unknown, GitHubPRInfoDetails> = {
    name: "github_get_pr",
    label: "github_get_pr",
    description:
      "Fetch pull request details including status, review decision, and metadata. Use before reviewing or merging.",
    parameters: Type.Object({
      prNumber: Type.Number({ description: "Pull request number" }),
      repo: Type.Optional(
        Type.String({ description: "Repository in owner/repo format (defaults to current repo)" }),
      ),
      workdir: Type.Optional(
        Type.String({ description: "Working directory (defaults to current directory)" }),
      ),
    }),
    execute: async (_toolCallId, args) => {
      const params = args as {
        prNumber: number;
        repo?: string;
        workdir?: string;
      };

      const workdir = params.workdir || defaults?.workdir;

      // Fetch PR details as JSON
      let command = `gh pr view ${params.prNumber} --json number,title,body,state,baseRefName,headRefName,author,reviewDecision,mergeable,url`;

      if (params.repo) {
        command += ` --repo ${params.repo}`;
      }

      try {
        const result = await execFn({ command, workdir, timeout: 30 });

        if (result.exitCode !== 0) {
          throw new Error(
            `Failed to fetch PR info: ${result.stderr || result.stdout || "Unknown error"}`,
          );
        }

        const prData = JSON.parse(result.stdout) as {
          number: number;
          title: string;
          body: string;
          state: string;
          baseRefName: string;
          headRefName: string;
          author: { login: string };
          reviewDecision?: string;
          mergeable?: string;
          url: string;
        };

        const status =
          prData.state === "MERGED" ? "merged" : prData.state === "CLOSED" ? "closed" : "open";

        return {
          content: [
            {
              type: "text",
              text: `PR #${prData.number}: ${prData.title}\n\nStatus: ${status.toUpperCase()}\nBase: ${prData.baseRefName} ← Head: ${prData.headRefName}\nAuthor: @${prData.author.login}\nReview: ${prData.reviewDecision || "PENDING"}\nMergeable: ${prData.mergeable || "UNKNOWN"}\n\n${prData.url}`,
            },
          ],
          details: {
            status,
            prNumber: prData.number,
            title: prData.title,
            body: prData.body,
            base: prData.baseRefName,
            head: prData.headRefName,
            author: prData.author.login,
            reviewDecision: prData.reviewDecision,
            mergeable: prData.mergeable,
            url: prData.url,
          },
        };
      } catch (err) {
        throw new Error(`GitHub PR info fetch failed: ${String(err)}`);
      }
    },
  };

  // Tool: Comment on PR
  const commentPR: AgentTool<unknown, { status: "commented"; prNumber: number }> = {
    name: "github_comment_pr",
    label: "github_comment_pr",
    description: "Add a comment to a pull request. Use for feedback, questions, or status updates.",
    parameters: Type.Object({
      prNumber: Type.Number({ description: "Pull request number" }),
      body: Type.String({ description: "Comment text (markdown supported)" }),
      repo: Type.Optional(
        Type.String({ description: "Repository in owner/repo format (defaults to current repo)" }),
      ),
      workdir: Type.Optional(
        Type.String({ description: "Working directory (defaults to current directory)" }),
      ),
    }),
    execute: async (_toolCallId, args) => {
      const params = args as {
        prNumber: number;
        body: string;
        repo?: string;
        workdir?: string;
      };

      const workdir = params.workdir || defaults?.workdir;

      // Build gh pr comment command
      let command = `gh pr comment ${params.prNumber}`;
      command = buildGhCommand(command, params.body);

      if (params.repo) {
        command += ` --repo ${params.repo}`;
      }

      try {
        const result = await execFn({ command, workdir, timeout: 30 });

        if (result.exitCode !== 0) {
          throw new Error(
            `Failed to comment on PR: ${result.stderr || result.stdout || "Unknown error"}`,
          );
        }

        return {
          content: [
            {
              type: "text",
              text: `💬 Comment added to PR #${params.prNumber}\n\n${params.body}`,
            },
          ],
          details: {
            status: "commented",
            prNumber: params.prNumber,
          },
        };
      } catch (err) {
        throw new Error(`GitHub PR comment failed: ${String(err)}`);
      }
    },
  };

  return {
    createPR,
    reviewPR,
    mergePR,
    getPRInfo,
    commentPR,
  };
}
