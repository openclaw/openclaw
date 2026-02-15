/**
 * GitHub API helpers and shared utilities for PR triage.
 * Handles data fetching, pagination, PR summary generation,
 * input sanitization, output validation, and deterministic signals.
 *
 * Rate limit budget: uses GraphQL for batch file fetching (~10 calls
 * instead of ~500 REST calls). Checks budget before starting and
 * degrades gracefully when rate-limited.
 */

const GITHUB_API = "https://api.github.com";
const GRAPHQL_API = "https://api.github.com/graphql";
const MIN_RATE_LIMIT_BUDGET = 100;

export function createGitHubClient(token) {
  async function gh(path, opts = {}) {
    const url = path.startsWith("http") ? path : `${GITHUB_API}${path}`;
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetch(url, {
        headers: {
          Authorization: `token ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          ...opts.headers,
        },
        ...opts,
      });
      if (res.ok) {
        return res.json();
      }
      const isRateLimit =
        res.status === 429 ||
        (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0");
      if (isRateLimit || res.status >= 500) {
        const resetEpoch = Number(res.headers.get("x-ratelimit-reset") || 0);
        const waitSec = resetEpoch
          ? Math.max(1, resetEpoch - Math.floor(Date.now() / 1000))
          : Math.pow(2, attempt);
        const delay = Math.min(waitSec * 1000, 60_000);
        console.warn(
          `GitHub API ${res.status} on ${path}, retry in ${Math.round(delay / 1000)}s (${attempt + 1}/3)`,
        );
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      const body = await res.text().catch(() => "");
      throw new Error(`GitHub API ${res.status}: ${path} — ${body.slice(0, 200)}`);
    }
    throw new Error(`GitHub API failed after 3 retries: ${path}`);
  }

  async function ghGraphQL(query, variables = {}) {
    const res = await fetch(GRAPHQL_API, {
      method: "POST",
      headers: {
        Authorization: `bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`GitHub GraphQL ${res.status}: ${body.slice(0, 200)}`);
    }
    const data = await res.json();
    if (data.errors?.length) {
      throw new Error(`GraphQL error: ${data.errors[0].message}`);
    }
    return data.data;
  }

  async function ghPaginate(path, maxItems = 100) {
    const items = [];
    let page = 1;
    while (items.length < maxItems) {
      const perPage = Math.min(100, maxItems - items.length);
      const sep = path.includes("?") ? "&" : "?";
      const data = await gh(`${path}${sep}per_page=${perPage}&page=${page}`);
      if (!Array.isArray(data) || data.length === 0) {
        break;
      }
      items.push(...data);
      if (data.length < perPage) {
        break;
      }
      page++;
    }
    return items;
  }

  return { gh, ghGraphQL, ghPaginate };
}

/**
 * Check rate limit budget. Returns { remaining, resetAt, ok }.
 * If remaining < MIN_RATE_LIMIT_BUDGET, logs a warning and returns ok=false.
 */
export async function checkRateBudget(gh) {
  try {
    const data = await gh("/rate_limit");
    const core = data.resources?.core || {};
    const remaining = core.remaining ?? 5000;
    const resetAt = new Date((core.reset || 0) * 1000).toISOString();
    if (remaining < MIN_RATE_LIMIT_BUDGET) {
      console.warn(`Rate limit budget low: ${remaining} remaining (resets ${resetAt})`);
      return { remaining, resetAt, ok: false };
    }
    console.log(`Rate limit budget: ${remaining} remaining`);
    return { remaining, resetAt, ok: true };
  } catch {
    console.warn("Could not check rate limit — proceeding cautiously");
    return { remaining: 0, resetAt: "", ok: true };
  }
}

/**
 * Extract issue refs with contextual matching to reduce false positives.
 * Only matches GitHub-style references: "fixes #N", "closes #N", bare "#N" at line starts.
 */
export function extractIssueRefs(text) {
  if (!text) {
    return [];
  }
  const contextual =
    text.match(/(?:fix(?:es)?|close[sd]?|resolve[sd]?|refs?|see|relates?\s+to)\s+#(\d{1,6})/gi) ||
    [];
  const bare = text.match(/(?:^|\n)\s*[-*]?\s*#(\d{1,6})\b/g) || [];
  const all = [...contextual, ...bare]
    .map((m) => {
      const match = m.match(/#(\d{1,6})/);
      return match ? `#${match[1]}` : null;
    })
    .filter(Boolean);
  return [...new Set(all)];
}

export function computeFileOverlap(filesA, filesB) {
  if (!filesA.length || !filesB.length) {
    return 0;
  }
  const setA = new Set(filesA);
  const intersection = filesB.filter((f) => setA.has(f));
  const union = new Set([...filesA, ...filesB]);
  return intersection.length / union.size;
}

function shortPath(filepath) {
  const parts = filepath.split("/");
  return parts.length > 2 ? parts.slice(-2).join("/") : filepath;
}

function summarizePR(pr) {
  const issueRefs = extractIssueRefs(pr.title + " " + (pr.body || ""));
  const shortFiles = (pr.files || []).slice(0, 6).map(shortPath);
  const moreFiles = (pr.files?.length || 0) > 6 ? ` +${pr.files.length - 6}` : "";
  const refs = issueRefs.length ? ` refs:${issueRefs.join(",")}` : "";
  const size = `+${pr.additions}/-${pr.deletions} ${pr.changed_files ?? pr.files?.length ?? "?"}f`;
  const safeTitle = sanitizeUntrusted(pr.title, 200);
  return `#${pr.number} ${safeTitle} ${size}\n  ${shortFiles.join(",")}${moreFiles}${refs}`;
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
    body: (pr.body || "").slice(0, 4000),
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

/**
 * Batch-fetch PR file lists via GraphQL.
 * Fetches up to 50 PRs per query (GitHub GraphQL node limit).
 * Returns Map<number, string[]> of PR number → file paths.
 * Uses ~1 API call per 50 PRs instead of 1 per PR.
 */
async function batchFetchFiles(ghGraphQL, owner, name, prNumbers) {
  const fileMap = new Map();
  const BATCH_SIZE = 50;

  for (let i = 0; i < prNumbers.length; i += BATCH_SIZE) {
    const batch = prNumbers.slice(i, i + BATCH_SIZE);
    const aliases = batch
      .map(
        (n, idx) => `pr${idx}: pullRequest(number: ${n}) {
      number
      files(first: 100) { nodes { path } }
    }`,
      )
      .join("\n");

    const query = `query { repository(owner: "${owner}", name: "${name}") { ${aliases} } }`;
    try {
      const data = await ghGraphQL(query);
      const repo = data.repository || {};
      for (let idx = 0; idx < batch.length; idx++) {
        const pr = repo[`pr${idx}`];
        if (pr?.files?.nodes) {
          fileMap.set(
            pr.number,
            pr.files.nodes.map((f) => f.path),
          );
        }
      }
    } catch (err) {
      console.warn(
        `GraphQL batch file fetch failed (batch ${i}-${i + batch.length}): ${err.message}`,
      );
      // Graceful degradation — PRs in this batch get empty file lists
      for (const n of batch) {
        fileMap.set(n, []);
      }
    }
  }
  return fileMap;
}

/**
 * Fetch open PR summaries AND a file map for Jaccard computation.
 * Returns { summaries: string[], fileMap: Map<number, string[]> }
 *
 * Uses GraphQL batch queries for file lists: ~10 API calls for 500 PRs
 * instead of 500 individual REST calls.
 * If skipFiles=true, skips file fetching entirely (semantic-only triage).
 */
export async function getOpenPRSummaries(
  gh,
  ghGraphQL,
  ghPaginate,
  repo,
  maxOpenPRs,
  skipFiles = false,
) {
  const prs = await ghPaginate(
    `/repos/${repo}/pulls?state=open&sort=created&direction=desc`,
    maxOpenPRs,
  );
  const [owner, name] = repo.split("/");

  let fileMap;
  if (skipFiles) {
    console.log("Skipping file fetches (rate limit budget conservation)");
    fileMap = new Map(prs.map((pr) => [pr.number, []]));
  } else {
    const prNumbers = prs.map((pr) => pr.number);
    fileMap = await batchFetchFiles(ghGraphQL, owner, name, prNumbers);
    // Ensure all PRs have an entry even if GraphQL missed some
    for (const pr of prs) {
      if (!fileMap.has(pr.number)) {
        fileMap.set(pr.number, []);
      }
    }
  }

  const summaries = [];
  for (const pr of prs) {
    const files = fileMap.get(pr.number) || [];
    summaries.push(summarizePR({ ...pr, author: pr.user?.login, files }));
  }
  return { summaries, fileMap };
}

export async function getRecentDecisions(ghPaginate, repo, maxHistory) {
  const merged = await ghPaginate(
    `/repos/${repo}/pulls?state=closed&sort=updated&direction=desc`,
    maxHistory * 2,
  );
  const mergedPRs = merged
    .filter((pr) => pr.merged_at)
    .slice(0, maxHistory)
    .map(
      (pr) =>
        `MERGED #${pr.number}: ${sanitizeUntrusted(pr.title, 200)} (by ${pr.user?.login}, +${pr.additions}/-${pr.deletions})`,
    );
  const rejectedPRs = merged
    .filter((pr) => !pr.merged_at)
    .slice(0, maxHistory)
    .map(
      (pr) =>
        `CLOSED #${pr.number}: ${sanitizeUntrusted(pr.title, 200)} (by ${pr.user?.login}, +${pr.additions}/-${pr.deletions})`,
    );
  return { mergedPRs, rejectedPRs };
}

// --- Shared enums (single source of truth for schema + validation) ---

export const VALID_CATEGORIES = ["bug", "feature", "refactor", "test", "docs", "chore"];
export const VALID_CONFIDENCE = ["high", "medium", "low"];
export const VALID_ACTIONS = [
  "needs-review",
  "likely-duplicate",
  "needs-discussion",
  "auto-label-only",
  "fast-track",
];

// --- JSON Schema for structured output ---

export const TRIAGE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    duplicate_of: {
      type: "array",
      items: { type: "integer" },
      description: "PR numbers this is a duplicate of",
    },
    related_to: {
      type: "array",
      items: { type: "integer" },
      description: "PR numbers with related/overlapping work",
    },
    category: { type: "string", enum: VALID_CATEGORIES },
    confidence: { type: "string", enum: VALID_CONFIDENCE },
    quality_signals: {
      type: "object",
      additionalProperties: false,
      properties: {
        focused_scope: { type: "boolean" },
        has_tests: { type: "boolean" },
        appropriate_size: { type: "boolean" },
        references_issue: { type: "boolean" },
      },
      required: ["focused_scope", "has_tests", "appropriate_size", "references_issue"],
    },
    suggested_action: {
      type: "string",
      enum: VALID_ACTIONS,
    },
    reasoning: { type: "string", description: "Brief explanation of the triage decision" },
  },
  required: [
    "duplicate_of",
    "related_to",
    "category",
    "confidence",
    "quality_signals",
    "suggested_action",
    "reasoning",
  ],
};

// --- Prompt injection defense ---

export function sanitizeUntrusted(text, maxLen) {
  if (!text) {
    return "";
  }
  return text
    .slice(0, maxLen)
    .replace(/```/g, "'''")
    .replace(
      /<\/?(?:system|human|assistant|instructions?|prompt|ignore|override|rules|task|open_prs|maintainer_decisions|new_pr|deterministic_signals|merged|closed_without_merge|project_focus|context|thinking|tool_use|function_call)[^>]*>/gi,
      "[FILTERED]",
    );
}

// --- JSON extraction from LLM response ---

export function extractJSON(text) {
  try {
    return JSON.parse(text);
  } catch {}
  return null;
}

// --- Output validation ---

export function validateTriageOutput(triage, knownPRNumbers) {
  if (!triage || typeof triage !== "object") {
    return null;
  }

  const validPRs = new Set(knownPRNumbers);

  if (Array.isArray(triage.duplicate_of)) {
    triage.duplicate_of = triage.duplicate_of.filter((n) => validPRs.has(n));
  } else {
    triage.duplicate_of = [];
  }

  if (Array.isArray(triage.related_to)) {
    triage.related_to = triage.related_to.filter((n) => validPRs.has(n));
  } else {
    triage.related_to = [];
  }

  if (!VALID_CATEGORIES.includes(triage.category)) {
    triage.category = "chore";
  }

  if (!VALID_CONFIDENCE.includes(triage.confidence)) {
    triage.confidence = "low";
  }

  if (!VALID_ACTIONS.includes(triage.suggested_action)) {
    triage.suggested_action = "needs-review";
  }

  if (!triage.quality_signals || typeof triage.quality_signals !== "object") {
    triage.quality_signals = {
      focused_scope: true,
      has_tests: false,
      appropriate_size: true,
      references_issue: false,
    };
  }

  if (triage.suggested_action === "likely-duplicate" && triage.duplicate_of.length === 0) {
    triage.suggested_action = "needs-review";
    triage.confidence = "low";
  }

  return triage;
}

// --- Deterministic pre-enrichment (uses structured fileMap) ---

function getDirs(files) {
  return new Set(
    files.map((f) => {
      const parts = f.split("/");
      return parts.length > 1 ? parts.slice(0, -1).join("/") : ".";
    }),
  );
}

export function jaccardSets(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  const intersection = [...a].filter((x) => b.has(x));
  const union = new Set([...a, ...b]);
  return intersection.length / union.size;
}

export function deterministicSignals(targetPR, fileMap) {
  const targetFiles = targetPR.files || [];
  const targetDirs = getDirs(targetFiles);
  const signals = [];

  for (const [prNum, prFiles] of fileMap) {
    if (prNum === targetPR.number) {
      continue;
    }
    const jaccard = computeFileOverlap(targetFiles, prFiles);
    const dirJaccard = jaccardSets(targetDirs, getDirs(prFiles));

    if (jaccard > 0.3 || dirJaccard > 0.5) {
      signals.push({
        pr: prNum,
        jaccard: Math.round(jaccard * 100) / 100,
        dirJaccard: Math.round(dirJaccard * 100) / 100,
      });
    }
  }

  return signals;
}
