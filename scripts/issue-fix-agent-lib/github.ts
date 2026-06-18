import type { CommandRunner } from "./command-runner.js";
import type { IssueCandidate } from "./types.js";

type GitcrawlIssue = {
  number?: number;
  title?: string;
  url?: string;
  body?: string;
  labels?: readonly (string | { name?: string })[];
  author?: { login?: string } | string;
  updatedAt?: string;
  pullRequest?: unknown;
};

function parseJsonLines(stdout: string): unknown[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown);
}

function normalizeLabels(labels: GitcrawlIssue["labels"]): string[] {
  return (labels ?? []).flatMap((label) =>
    typeof label === "string" ? [label] : label.name ? [label.name] : [],
  );
}

function normalizeAuthor(author: GitcrawlIssue["author"]): string {
  return typeof author === "string" ? author : (author?.login ?? "unknown");
}

function normalizeIssue(raw: GitcrawlIssue): IssueCandidate | null {
  if (!raw.number || !raw.title || !raw.url) {
    return null;
  }
  return {
    author: normalizeAuthor(raw.author),
    body: raw.body ?? "",
    isPullRequest: raw.pullRequest !== undefined,
    labels: normalizeLabels(raw.labels),
    number: raw.number,
    title: raw.title,
    updatedAt: raw.updatedAt ?? "",
    url: raw.url,
  };
}

export async function fetchOpenIssueCandidates(params: {
  limit: number;
  runCommand: CommandRunner;
}): Promise<IssueCandidate[]> {
  const result = await params.runCommand("gitcrawl", [
    "search",
    "issues",
    "repo:openclaw/openclaw state:open",
    "-R",
    "openclaw/openclaw",
    "--state",
    "open",
    "--json",
    "number,title,url,body,labels,author,updatedAt",
    "--limit",
    String(params.limit),
  ]);
  if (result.code !== 0) {
    throw new Error(`gitcrawl issue search failed: ${result.stderr || result.stdout}`);
  }
  return parseJsonLines(result.stdout)
    .map((entry) => normalizeIssue(entry as GitcrawlIssue))
    .filter((entry): entry is IssueCandidate => entry !== null);
}
