---
description: Fetch PR review feedback
---

# Fetch Feedback Stage

Your task is to gather PR review feedback and create a clear goal for addressing it.

## Steps

1. **Identify the PR**:
   - Get PR for current branch: `gh pr view --json number,title,state,url,reviewDecision`
   - If no PR exists, report this and stop

2. **Fetch all feedback**:
   - Get PR comments: `gh pr view --json comments --jq '.comments[] | "**\(.author.login)**: \(.body)"'`
   - Get review comments (on specific lines): `gh api repos/{owner}/{repo}/pulls/{number}/comments --jq '.[] | "**\(.user.login)** on \(.path):\(.line): \(.body)"'`
   - Get review requests: `gh pr view --json reviews --jq '.reviews[] | "**\(.author.login)** (\(.state)): \(.body)"'`

3. **Get PR diff for context**:
   - Run: `gh pr diff`
   - This helps understand what was changed and what feedback applies to

4. **Write the goal file**:
   - Write to `{run_dir}/goal.md` with this structure:

```
# PR Review Feedback

## PR Information
- PR: #{number} - {title}
- URL: {url}
- Status: {state}
- Review Decision: {reviewDecision}

## Feedback to Address

### Review Comments
{List each review comment with file/line context}

### General Comments
{List general PR comments}

### Review Summaries
{List review summaries from approvers/requesters}

## Action Items
Based on the feedback above, here are the specific changes needed:

1. {First change needed with file reference}
2. {Second change needed}
...

## Original Changes (for context)
The PR contains changes to these files:
{List of changed files from diff}
```

5. **Summarize for the next stage**:
   - Print a summary of what feedback was found
   - List the action items clearly

## Notes

- If there's no feedback (PR is approved with no comments), note this and the implement stage can be skipped
- Focus on actionable feedback - ignore "LGTM" or "looks good" comments
- Group related feedback together when creating action items
- Include file paths and line numbers when available
