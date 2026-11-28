# Duplicate evidence discovery

## Step 1: Read The Target

Start by reading the target itself.
Use live GitHub for current target state.

For a PR:

```bash
gh pr view <number> --json number,title,state,mergedAt,body,closingIssuesReferences,files,comments,reviews,statusCheckRollup
```

For an issue:

```bash
gh issue view <number> --json number,title,state,body,comments,closedAt
```

Record:

- target type and number
- title
- problem statement
- proposed intent
- subsystem
- whether it is open, closed, or merged
- whether there is already a likely duplicate thread mentioned by humans

## Step 2: Search Broadly With Gitcrawl

Use `gitcrawl` first because it is the local OpenClaw history and clustering source.
Do not switch to broad live GitHub search unless `gitcrawl` is missing data, stale, or failing.

Start with the target and nearby threads:

```bash
gitcrawl threads openclaw/openclaw --numbers <issue-or-pr-number> --include-closed --json
gitcrawl neighbors openclaw/openclaw --number <issue-or-pr-number> --limit 20 --json
```

Then search key phrases and subsystem terms:

```bash
gitcrawl search openclaw/openclaw --query "<key phrase from title or body>" --mode hybrid --limit 20 --json
gitcrawl search openclaw/openclaw --query "<subsystem or error phrase>" --mode hybrid --limit 20 --json
```

Inspect likely clusters:

```bash
gitcrawl cluster-detail openclaw/openclaw --id <cluster-id> --member-limit 20 --body-chars 280 --json
```

For PRs, verify likely code overlap with live file data:

```bash
gh pr view <candidate-pr> --json number,title,state,mergedAt,files,body,comments,reviews
```

For issues, verify likely duplicate issue state and comments live:

```bash
gh issue view <candidate-issue> --json number,title,state,body,comments,closedAt
```

## Step 3: Use Live GitHub Search For Gaps

Use targeted live GitHub search after `gitcrawl` when:

- the target is too new for the local store
- comments or reviews matter and the local store lacks them
- the exact phrase did not appear in local results but the issue/PR is current enough that GitHub should know it

```bash
gh search prs --repo openclaw/openclaw --match title,body --limit 50 -- "<key phrase>"
gh search issues --repo openclaw/openclaw --match title,body --limit 50 -- "<key phrase>"
gh search issues --repo openclaw/openclaw --match comments --limit 50 -- "<error or maintainer phrase>"
```
