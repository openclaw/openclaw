#!/usr/bin/env tsx
/**
 * Auto-Resolve Bot-Only Threads.
 *
 * After a clean current-head rerun:
 * - Auto-resolve unresolved threads where ALL comments are from the review bot
 * - Never auto-resolve human-participated threads
 * - Then rerun policy gate so required-conversation-resolution reflects new state
 */

import { execSync } from "node:child_process";

interface ReviewThread {
  id: string;
  isResolved: boolean;
  comments: Array<{
    author: string;
    body: string;
  }>;
}

function getReviewThreads(prNumber: number): ReviewThread[] {
  try {
    // Use GraphQL to get review threads with resolution state
    const query = `
      query($pr: Int!) {
        repository(owner: "{owner}", name: "{repo}") {
          pullRequest(number: $pr) {
            reviewThreads(first: 100) {
              nodes {
                id
                isResolved
                comments(first: 50) {
                  nodes {
                    author { login }
                    body
                  }
                }
              }
            }
          }
        }
      }
    `;

    const output = execSync(
      `gh api graphql -f query='${query.replace(/'/g, "'\\''")}' --jq '.data.repository.pullRequest.reviewThreads.nodes'`,
      { encoding: "utf-8" },
    );

    const threads = JSON.parse(output);
    return threads.map((t: any) => ({
      id: t.id,
      isResolved: t.isResolved,
      comments: t.comments.nodes.map((c: any) => ({
        author: c.author?.login ?? "unknown",
        body: c.body,
      })),
    }));
  } catch {
    return [];
  }
}

function resolveThread(threadId: string): void {
  const mutation = `
    mutation {
      resolveReviewThread(input: { threadId: "${threadId}" }) {
        thread { id isResolved }
      }
    }
  `;

  execSync(`gh api graphql -f query='${mutation.replace(/'/g, "'\\''")}'`, {
    encoding: "utf-8",
  });
}

export function autoResolveBotThreads(prNumber: number, reviewBotUsername: string): number {
  const threads = getReviewThreads(prNumber);
  let resolved = 0;

  for (const thread of threads) {
    if (thread.isResolved) continue;

    // Check if ALL comments are from the review bot
    const allFromBot = thread.comments.every(
      (c) => c.author === reviewBotUsername || c.author === `${reviewBotUsername}[bot]`,
    );

    if (allFromBot && thread.comments.length > 0) {
      console.log(`Auto-resolving thread ${thread.id} (${thread.comments.length} bot comments)`);
      resolveThread(thread.id);
      resolved++;
    } else if (!allFromBot) {
      const humanAuthors = thread.comments
        .filter((c) => c.author !== reviewBotUsername && c.author !== `${reviewBotUsername}[bot]`)
        .map((c) => c.author);
      console.log(
        `Skipping thread ${thread.id} — has human participants: ${[...new Set(humanAuthors)].join(", ")}`,
      );
    }
  }

  console.log(`Auto-resolved ${resolved} bot-only threads`);
  return resolved;
}

// ── Main ─────────────────────────────────────────────────────────────────

function main() {
  const prNumber = parseInt(process.env.PR_NUMBER ?? "0", 10);
  const reviewBot = process.env.REVIEW_BOT_USERNAME ?? "greptile";

  if (!prNumber) {
    console.error("PR_NUMBER is required");
    process.exit(1);
  }

  autoResolveBotThreads(prNumber, reviewBot);
}

main();
