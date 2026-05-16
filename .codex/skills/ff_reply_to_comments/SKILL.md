---
name: ff_reply_to_comments
description: Reply to PR comments after addressing feedback
---

# Reply to PR Comments

You are tasked with posting replies to PR comments after addressing the feedback.

## When to Use

This skill should be used after implementing changes based on PR review feedback. It helps track which comments have been addressed and provides context to reviewers.

## Steps

1. **Identify the PR**:
   - Get PR for current branch: `gh pr view --json number,title,url,state`
   - If no PR exists, report this and stop

2. **Fetch PR comments that need replies**:
   - Get PR comments: `gh pr view --json comments --jq '.comments[] | {id: .id, author: .author.login, body: .body, replies: .replies}'`
   - Get review comments (on specific lines): `gh api repos/{owner}/{repo}/pulls/{number}/comments --jq '.[] | {id: .id, author: .user.login, body: .body, path: .path, line: .line}'`

3. **Check for existing replies**:
   - Look for replies you've already posted to avoid duplicates
   - Focus on comments that don't have your replies yet

4. **Read the implementation context**:
   - Read the goal file at `{run_dir}/goal.md` to understand what was implemented
   - Review the changes made: `git diff HEAD~1` or relevant commits

5. **Post replies to addressed comments**:

For each comment that has been addressed:

```bash
# For general PR comments
gh api repos/{owner}/{repo}/issues/comments/{comment_id}/replies \
  -X POST \
  -f body="✅ **Addressed** - {brief description of the change made}"

# For review comments (line-specific)
gh api repos/{owner}/{repo}/pulls/{number}/comments \
  -X POST \
  -f commit_id=$(git rev-parse HEAD) \
  -f path="{file_path}" \
  -f line={line_number} \
  -f side=RIGHT \
  -f in_reply_to={comment_id} \
  -f body="✅ **Addressed** - {brief description of the change made}"
```

## Reply Templates

Use appropriate reply based on the action taken:

- **Fixed**: "✅ **Addressed** - Fixed in commit {sha}. {description of change}"
- **Implemented**: "✅ **Addressed** - Implemented as suggested. {details}"
- **Partially addressed**: "Partially addressed - {what was done}. {what remains/why not fully addressed}"
- **Discussed**: "💬 **Discussed** - {explanation of why the suggestion wasn't implemented}"
- **Clarification needed**: "❓ **Needs Clarification** - {question about the feedback}"

## Best Practices

1. **Be specific** - Reference the actual changes made
2. **Link commits** - Include commit SHAs when relevant
3. **Be concise** - Keep replies brief but informative
4. **Don't spam** - Only reply to comments you've actually addressed
5. **Acknowledge partially** - If you can only partially address feedback, explain why

## Example Workflow

```bash
# 1. Get PR number
gh pr view --json number --jq '.number'

# 2. List comments needing replies
gh pr view --json comments --jq '.comments[] | select(.replies | length == 0) | {id: .id, author: .author.login, body: .body[:100]}'

# 3. Post reply to comment
ghtoken=$(gh auth token)
curl -X POST \
  -H "Authorization: token $ghtoken" \
  -H "Accept: application/vnd.github+json" \
  -d '{"body":"✅ **Addressed** - Fixed in latest commit. Updated the function to handle edge cases as suggested."}' \
  https://api.github.com/repos/{owner}/{repo}/issues/comments/{comment_id}/replies
```

## Important

- Always verify the PR exists before attempting to post replies
- Handle API errors gracefully - some comments may not be reply-able
- Don't duplicate replies - check if you've already replied
- Respect rate limits - batch replies if there are many comments
