/**
 * Outbound adapter for sending messages/tasks to Cursor Agent.
 *
 * Converts OpenClaw messages to Cursor Background Agent tasks.
 */

import type { ChannelOutboundAdapter, ChannelOutboundContext } from "openclaw/plugin-sdk";
import { launchAgentTask, type LaunchAgentOptions } from "./api.js";
import type { CursorAgentAccountConfig } from "./types.js";
import { getTaskStore } from "./task-store.js";

function isAccountConfigured(account: CursorAgentAccountConfig | null): boolean {
  return !!account?.apiKey && account.apiKey.length > 0;
}

/**
 * Extract repository URL from message or use default.
 * Supports formats like:
 * - "Fix bug in https://github.com/user/repo"
 * - "@repo:https://github.com/user/repo Fix bug"
 */
function extractRepository(
  body: string,
  defaultRepo?: string,
): { repo: string; cleanBody: string } {
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

  throw new Error(
    "No repository specified. Use @repo:https://github.com/user/repo or configure a default repository.",
  );
}

/**
 * Extract branch from message or use default.
 * Supports format: @branch:feature-branch
 */
function extractBranch(
  body: string,
  defaultBranch: string = "main",
): { branch: string; cleanBody: string } {
  const branchMatch = body.match(/@branch:(\S+)/i);
  if (branchMatch) {
    return {
      branch: branchMatch[1],
      cleanBody: body.replace(branchMatch[0], "").trim(),
    };
  }
  return { branch: defaultBranch, cleanBody: body };
}

export const cursorAgentOutbound: ChannelOutboundAdapter<CursorAgentAccountConfig> = {
  async sendMessage(ctx: ChannelOutboundContext<CursorAgentAccountConfig>): Promise<void> {
    const { account, accountId, body, runtime } = ctx;

    if (!account || !isAccountConfigured(account)) {
      throw new Error(`Cursor Agent account ${accountId} is not configured`);
    }

    // Extract repository and branch from message
    const { repo, cleanBody: bodyAfterRepo } = extractRepository(body, account.repository);
    const { branch, cleanBody: instructions } = extractBranch(bodyAfterRepo, account.branch);

    // Build full instructions with optional prefix
    const fullInstructions = account.defaultInstructions
      ? `${account.defaultInstructions}\n\n${instructions}`
      : instructions;

    runtime.log(
      `Sending task to Cursor Agent (${repo}@${branch}): ${instructions.substring(0, 80)}...`,
    );

    try {
      const options: LaunchAgentOptions = {
        instructions: fullInstructions,
        repository: repo,
        branch: branch,
        webhookUrl: account.webhookUrl,
      };

      const response = await launchAgentTask(account, options);
      runtime.log(`Cursor Agent task launched: ${response.id} (status: ${response.status})`);

      // Store task for session correlation
      const taskStore = getTaskStore();
      taskStore.set(response.id, {
        id: response.id,
        sessionKey: (ctx as any).sessionKey || "unknown",
        accountId,
        instructions,
        repository: repo,
        branch,
        status: response.status,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    } catch (error) {
      runtime.error(`Failed to launch Cursor Agent task: ${String(error)}`);
      throw error;
    }
  },

  async sendToolResult(ctx: ChannelOutboundContext<CursorAgentAccountConfig>): Promise<void> {
    // For tool results, treat as a follow-up if we have an active task
    // Otherwise, launch a new task
    return cursorAgentOutbound.sendMessage(ctx);
  },
};
