# PR: fix(subagents): save long outputs to file instead of truncating

**Branch:** `pr/subagent-output-file-saving`  
**Target:** `upstream/main`  
**Status:** Ready to open  
**Supersedes:** PR #25190 (ZadaWu's truncation approach)  
**Closes (partially):** #25110

---

## Pre-Open Checklist

- [ ] Comment on PR #25190 FIRST (explain our different approach, be respectful — ZadaWu has been actively working on it)
- [ ] Push branch to fork: `git push origin pr/subagent-output-file-saving`
- [ ] Open PR against `openclaw/openclaw:main`
- [ ] Link to #25110 in PR body
- [ ] Reference #25190 as the competing approach (explain why file-save is better for large outputs)

---

## PR Description

```markdown
## Problem

When a sub-agent produces output longer than Telegram's 4096 char limit, the
announce silently fails: the channel rejects the send, 3 retries exhaust,
and the user sees a ❌ with no indication the task actually succeeded.

Fixes #25110. Reproduced on Ubuntu 24.04, v2026.2.23-beta.1, Node 22.22.0.

## Approach

Instead of truncating the output (see #25190), save it to a file and show a
preview + path in the message. This preserves the full output while keeping
the channel message within limits.

**Why file-save over truncation:**

- Truncation loses data; the user has no way to get the rest
- File path gives Atlas and the user a reference they can actually use
- Fits naturally with the workspace model (`sessions_history` already exists
  for in-session retrieval; a file path is the equivalent for long outputs)

## Changes

**`resolveSubagentOutputDir(cfg)`**  
Reads `agents.defaults.subagents.outputDir` or defaults to
`~/.openclaw/workspace/tmp/agent-output`.

**`saveOutputToTempFile({ findings, label, runId, outputDir })`**  
Writes findings to `{timestamp}-{label}-{runId}.md`. Returns `undefined` on
write failure (best-effort, doesn't break announce flow).

**`buildCompletionDeliveryMessage()`**  
Now accepts `outputFilePath` instead of `announceType`. When a path is
provided, shows a 1500-char preview + workspace-relative path:
```

…preview of output…

_Full output saved: `tmp/agent-output/2026-03-01T03-44-27-research-abc12345.md`_

```

When no path (output ≤ 3000 chars), falls back to the existing 3000-char
truncation with `sessions_history` hint.

**`runSubagentAnnounceFlow()`**
Saves output when `findings.length > 3000`. Also uses truncated preview
(1500 chars + path) in `internalSummaryMessage` for context efficiency.

## Testing

All 67 existing announce tests pass. No new tests needed for this change —
the file-save path is best-effort and the message formatting changes are
covered by existing format tests.
```

---

## Comment on PR #25190 (Post BEFORE Opening)

```markdown
Thanks for working on this — I ran into the same issue (#25110) and tried a
slightly different approach: instead of truncating, save the full output to a
file and show a preview + path in the message.

The advantage is the user (and Atlas) can still access the complete result via
the file path, rather than losing the tail of the output. Particularly useful
for research tasks where the summary is at the end.

Branch is ready if maintainers want to compare approaches: `Drickon:pr/subagent-output-file-saving`
```

---

## Notes

- Our approach and #25190 solve the same bug. Maintainers may prefer truncation (simpler), file-save (preserves data), or something else entirely. Be ready to adapt.
- If maintainers close ours in favor of #25190, that's fine — the bug gets fixed either way.
- The `outputDir` config option is a nice bonus — power users can redirect to a different location.
