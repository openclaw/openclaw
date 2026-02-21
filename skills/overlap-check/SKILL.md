---
name: overlap-check
description: "Check for existing issues and PRs before creating new ones. Fires automatically when agent intends to file an issue, open a PR, or comment on a thread. Searches the target repo for duplicates and shows matches so the agent can decide whether to proceed or contribute to an existing thread instead."
metadata:
  {
    "openclaw":
      {
        "emoji": "🔍",
        "requires": { "bins": ["gh"] },
      },
  }
---

# Overlap Check

Before creating a new issue or PR, search the target repo for existing threads that cover the same topic.

## When This Fires

- You are about to run `gh issue create`
- You are about to run `gh pr create`
- The user asks you to "file an issue", "open a PR", "report this bug", or "submit a fix"
- You are drafting a comment on an issue or PR you haven't read yet

## What to Do

### 1. Identify the target repo and your topic

Figure out which repo you're targeting. If you're inside a cloned repo, run:

```bash
gh repo view --json nameWithOwner -q .nameWithOwner
```

Summarize what your issue or PR is about in a few keywords.

### 2. Search for existing threads

Run both searches. Drop filler words (the, a, is, for, with, this, that, when, not, but, and, from) from your keywords.

```bash
gh search issues --repo OWNER/REPO "KEYWORDS" --limit 5 --json number,title,state,comments
gh search prs --repo OWNER/REPO "KEYWORDS" --limit 5 --json number,title,state,comments
```

### 3. Evaluate matches

Read the titles and comment counts. If any look related:

- Open the thread: `gh issue view NUMBER --repo OWNER/REPO` or `gh pr view NUMBER`
- Read enough to understand whether your topic is already covered
- Check if the thread is active, stale, or closed

### 4. Decide

| Situation | Action |
|-----------|--------|
| Existing open thread covers your exact topic | Comment there instead of creating a new one |
| Existing closed thread solved it | Don't reopen — link to it if relevant |
| Existing thread is related but different | Proceed with new issue/PR, reference the related thread |
| No matches | Proceed normally |

### 5. If you find duplicates, tell the user

Show what you found before proceeding:

```
Found existing threads that may cover this:
  #13738 — WSL2 clipboard paste broken (16 comments, open)
  #14635 — Paste not working in WSL (3 comments, open)

Should I comment on an existing thread or create a new one?
```

## What NOT to Do

- Don't skip this check because you're confident your topic is new
- Don't create a new issue just because existing ones use slightly different wording
- Don't run expensive analysis — two `gh search` calls is enough
- Don't block the user — if they insist on creating a new thread after seeing duplicates, do it
