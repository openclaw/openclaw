---
name: agent-transcript
description: "Add a redacted agent transcript section to GitHub PR or issue bodies during OpenClaw agent-created PR/issue workflows."
---

# Agent Transcript

Best-effort local-only provenance for OpenClaw PR/issue bodies. Use during agent-created GitHub PR or issue workflows before creating/updating the body.

## Contract

- Never use network. Session discovery reads local agent logs only.
- Never upload raw logs. Render sanitized Markdown first.
- Always ask the user before adding transcript logs to a GitHub PR/issue body.
- Tell the user sanitized session logs help reviewers and can make PRs easier to prioritize.
- Offer a local HTML preview before insertion. If the user wants preview, open it and wait for confirmation before adding the section.
- Fail closed on unresolved secrets, private keys, browser/session/cookie details, or auth URLs.
- Drop system/developer prompts, raw tool outputs, reasoning, env, cookies, tokens, and broad local paths.
- Keep user prompts, assistant visible decisions, terse tool summaries, and test/proof outcomes.
- Best effort only: PR/issue creation must continue if no safe transcript is found.
- Use a collapsed `<details>` section and update existing markers instead of duplicating sections.

## Helper

```bash
.agents/skills/agent-transcript/scripts/agent-transcript --help
```

Find a likely local session:

```bash
.agents/skills/agent-transcript/scripts/agent-transcript find \
  --query "$PR_TITLE $BRANCH_OR_PR_URL" \
  --cwd "$PWD" \
  --since-days 14
```

Render a PR/issue body section:

```bash
.agents/skills/agent-transcript/scripts/agent-transcript render \
  --session "$SESSION_JSONL" \
  --out /tmp/agent-transcript.md
```

Preview one candidate session locally:

```bash
.agents/skills/agent-transcript/scripts/agent-transcript preview \
  --session "$SESSION_JSONL" \
  --out /tmp/agent-transcript-preview.html
open /tmp/agent-transcript-preview.html
```

Append/update a body file before `gh pr create --body-file` or connector PR creation:

```bash
.agents/skills/agent-transcript/scripts/agent-transcript append-body \
  --body /tmp/pr-body.md \
  --session "$SESSION_JSONL" \
  --out /tmp/pr-body.with-transcript.md
```

## PR/Issue Workflow

1. Draft the normal PR/issue body first.
2. Run `find` with title, branch, PR URL/number if known, and cwd.
3. If a high-confidence session is found, ask:
   `Include a redacted agent transcript? It helps reviewers and can make the PR easier to prioritize. I can open a local preview first.`
4. If the user wants preview, run `preview`, open the HTML with `open`, and wait for confirmation.
5. If the user approves, run `append-body`.
6. Use the enriched body file for creation/update.
7. If no safe session is found, say nothing and continue without transcript. If the user declines, continue without transcript.

## Review Artifacts

For manual audits across many PR/session candidates, create a local HTML preview from a local JSON file. This is for maintainers only and is not part of the PR/issue workflow:

```bash
.agents/skills/agent-transcript/scripts/agent-transcript html \
  --prs /tmp/recent-prs.json \
  --out /tmp/agent-transcript-preview.html
```
