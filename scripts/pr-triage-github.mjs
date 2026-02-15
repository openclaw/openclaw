/**
 * GitHub API helpers for PR triage.
 * Handles data fetching, pagination, and PR summary generation.
 */

const GITHUB_API = "https://api.github.com";

export function createGitHubClient(token) {
  async function gh(path, opts = {}) {
    const url = path.startsWith("http") ? path : `${GITHUB_API}${path}`;
    const res = await fetch(url, {
      headers: {
        Authorization: `token ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...opts.headers,
      },
      ...opts,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`GitHub API ${res.status}: ${path} — ${body.slice(0, 200)}`);
    }
    return res.json();
  }

  async function ghPaginate(path, maxItems = 100) {
    const items = [];
    let page = 1;
    while (items.length < maxItems) {
      const perPage = Math.min(100, maxItems - items.length);
      const sep = path.includes("?") ? "&" : "?";
      const data = await gh(`${path}${sep}per_page=${perPage}&page=${page}`);
      if (!Array.isArray(data) || data.length === 0) { break; }
      items.push(...data);
      if (data.length < perPage) { break; }
      page++;
    }
    return items;
  }

  return { gh, ghPaginate };
}

export function extractIssueRefs(text) {
  if (!text) { return []; }
  const matches = text.match(/#(\d{3,6})/g) || [];
  return [...new Set(matches)];
}

export function computeFileOverlap(filesA, filesB) {
  if (!filesA.length || !filesB.length) { return 0; }
  const setA = new Set(filesA);
  const intersection = filesB.filter((f) => setA.has(f));
  const union = new Set([...filesA, ...filesB]);
  return intersection.length / union.size;
}

function summarizePR(pr) {
  const issueRefs = extractIssueRefs(pr.title + " " + (pr.body || ""));
  return [
    `#${pr.number}: ${pr.title}`,
    `  author:${pr.user?.login || pr.author} +${pr.additions}/-${pr.deletions} ${pr.changed_files ?? pr.files?.length ?? "?"} files`,
    pr.files?.length
      ? `  files: ${pr.files.slice(0, 8).join(", ")}${pr.files.length > 8 ? ` (+${pr.files.length - 8} more)` : ""}`
      : "",
    issueRefs.length ? `  refs: ${issueRefs.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export async function getTargetPR(gh, repo, prNumber, maxDiffChars, token) {
  const pr = await gh(`/repos/${repo}/pulls/${prNumber}`);
  let diff = "";
  try {
    const res = await fetch(`${GITHUB_API}/repos/${repo}/pulls/${prNumber}`, {
      headers: {
        Authorization: `token ${token}`,
        Accept: "application/vnd.github.v3.diff",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (res.ok) {
      diff = await res.text();
      if (diff.length > maxDiffChars) {
        diff = diff.slice(0, maxDiffChars) + "\n... (truncated)";
      }
    }
  } catch {}

  const files = await gh(`/repos/${repo}/pulls/${prNumber}/files?per_page=100`);
  return {
    number: pr.number,
    title: pr.title,
    body: (pr.body || "").slice(0, 2000),
    author: pr.user?.login,
    branch: pr.head?.ref,
    additions: pr.additions,
    deletions: pr.deletions,
    changed_files: pr.changed_files,
    created_at: pr.created_at,
    files: files.map((f) => f.filename),
    diff,
  };
}

export async function getOpenPRSummaries(gh, ghPaginate, repo, maxOpenPRs) {
  const prs = await ghPaginate(`/repos/${repo}/pulls?state=open&sort=created&direction=desc`, maxOpenPRs);
  const summaries = [];
  for (const pr of prs) {
    let files = [];
    try {
      files = (await gh(`/repos/${repo}/pulls/${pr.number}/files?per_page=30`)).map((f) => f.filename);
    } catch {}
    summaries.push(summarizePR({ ...pr, author: pr.user?.login, files }));
  }
  return summaries;
}

export async function getRecentDecisions(ghPaginate, repo, maxHistory) {
  const merged = await ghPaginate(
    `/repos/${repo}/pulls?state=closed&sort=updated&direction=desc`,
    maxHistory * 2,
  );
  const mergedPRs = merged
    .filter((pr) => pr.merged_at)
    .slice(0, maxHistory)
    .map((pr) => `MERGED #${pr.number}: ${pr.title} (by ${pr.user?.login}, +${pr.additions}/-${pr.deletions})`);
  const rejectedPRs = merged
    .filter((pr) => !pr.merged_at)
    .slice(0, maxHistory)
    .map((pr) => `CLOSED #${pr.number}: ${pr.title} (by ${pr.user?.login}, +${pr.additions}/-${pr.deletions})`);
  return { mergedPRs, rejectedPRs };
}
