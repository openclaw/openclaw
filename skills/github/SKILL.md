---
name: github
description: "GitHub CLI for issues, PRs, CI/check logs, comments, reviews, releases, repos, and gh api queries."
metadata:
  {
    "openclaw":
      {
        "emoji": "🐙",
        "requires": { "bins": ["gh"] },
        "install":
          [
            {
              "id": "brew",
              "kind": "brew",
              "formula": "gh",
              "bins": ["gh"],
              "label": "Install GitHub CLI (brew)",
            },
          ],
      },
  }
---

# GitHub

Use `gh` for GitHub. Use `git` for local commits/branches/push/pull. Use code-reading tools for deep reviews.

## Auth

```bash
gh auth status
gh auth login
```

Gateway HOME can differ from operator HOME. If `gh` auth exists elsewhere, set `GH_CONFIG_DIR` in the gateway service env and restart.

## PRs

```bash
gh pr list --repo owner/repo --json number,title,state,author,url
gh pr view 55 --repo owner/repo --json title,body,author,files,commits,reviews,reviewDecision
gh pr checks 55 --repo owner/repo
gh pr diff 55 --repo owner/repo
gh pr create --repo owner/repo --title "feat: title" --body-file /tmp/pr.md
```

When creating or refreshing a PR body, append this final footer only when the Runtime line supplies `sessionUrl=<exact-url>`. Replace `<sessionUrl>` with that URL verbatim; do not construct or modify it. Omit the footer when `sessionUrl` is absent. Preserve any publication marker before exactly one footer, and keep the footer final:

```text
---
[View the OpenClaw team session](<sessionUrl>)
```

URLs work directly: `gh pr view https://github.com/owner/repo/pull/55`.

### Async merges

Use the repository's native landing workflow when provided. For authorized
programmatic merges elsewhere, use GitHub's [async merge API](https://docs.github.com/en/rest/pulls/pulls#merge-a-pull-request-asynchronously)
through `gh api`; `gh pr merge` does not select this API. Supply the reviewed head
SHA, preserve required reviews/checks, and check stack membership first: submitting
a stacked PR also merges or queues its open downstack PRs, which need their own
review and authorization.

```bash
gh api -H 'X-Octopool-Require: merge-async-v1' \
  --method PUT repos/owner/repo/pulls/55/merge-async \
  -H 'X-GitHub-Api-Version: 2026-03-10' \
  -f sha=REVIEWED_HEAD_SHA -f merge_method=squash -f merge_action=direct_merge
gh api -H 'X-Octopool-Require: merge-async-v1' \
  repos/owner/repo/pulls/55/merge-async/REQUEST_UUID \
  -H 'X-GitHub-Api-Version: 2026-03-10' -H 'Cache-Control: max-age=0'
```

Keep the Octopool guard header first after `api`. Protected older wrappers reject
it before they can rewrite merge authority; use an Octopool build containing
[the async guard](https://github.com/openclaw/octopool/pull/231) if it is refused.
The supported wrapper preserves SHA/method/action/bypass and only rewrites commit
text. Native `gh` can pass the header through. Do not remove it, disable policy,
or select a raw binary to work around a rejection.

Retain `details.uuid` from a `202` response before polling. `pending` means wait;
`merged` includes `details.sha`, which still needs final PR/head verification.
`enqueued` means queued, not merged: monitor the PR itself. To honor a configured
queue, use `merge_action=default` (or `merge_queue` to explicitly enqueue), omitting
direct-only method/title/message fields. Never enable `bypass_rules` without authorization.

On `failed`, report `details.message`. A `409` identifies an existing request;
inspect its UUID and options without resubmitting. Lost replies, polling errors,
and result expiry after 24 hours require reconciliation, never a blind retry or
synchronous fallback. Poll with bounded waits and fresh reads. Async processing
does not arm auto-merge for unmet checks; use the native workflow or `gh pr merge
--auto` when that behavior is authorized.

### Landing ownership

When the user asks to land or merge a PR, the terminal outcome is the PR's verified
GitHub state, not the end of a review, worker turn, or CI observation.

- Keep the job active until `gh pr view ... --json state,mergedAt,mergeCommit`
  proves `state` is `MERGED`.
- Treat review findings, merge conflicts, failed checks, and requested changes as
  continuation work when they are in scope. Patch them, rerun the required gates,
  and re-evaluate the exact updated head.
- A pending check is a wait state, not completion. Use the repository's supported
  wait or merge workflow; do not claim success from partial green checks.
- If work was delegated to a persistent session and that run stops before merge,
  continue the same session rather than treating its report as the final result.
- Stop as blocked only when continuing requires new authority, unavailable
  credentials, or a product decision that cannot be inferred safely. Report the
  exact blocker and leave the PR unmerged.

## Issues

```bash
gh issue list --repo owner/repo --state open --json number,title,labels,url
gh issue view 42 --repo owner/repo --json title,body,comments,labels,state
gh issue create --repo owner/repo --title "Bug: ..." --body-file /tmp/issue.md
gh issue comment 42 --repo owner/repo --body-file /tmp/comment.md
gh issue close 42 --repo owner/repo --comment "Fixed in ..."
```

## CI/runs

```bash
gh run list --repo owner/repo --limit 10
gh run view <run-id> --repo owner/repo --json status,conclusion,headSha,url
gh run view <run-id> --repo owner/repo --log-failed
gh run rerun <run-id> --repo owner/repo --failed
```

## API

```bash
gh api repos/owner/repo/pulls/55 --jq '.title, .state, .user.login'
gh api repos/owner/repo/labels --jq '.[].name'
gh api --cache 1h repos/owner/repo --jq '{stars: .stargazers_count, forks: .forks_count}'
```

Use `--json` + `--jq` for structured output. Use `--body-file` for comments/bodies containing backticks, shell snippets, env names, or user text.
