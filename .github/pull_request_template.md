<!--
Optional linked context:
Add a visible `Closes #<issue-number>` or `Related: #<issue-number>` line
below this comment.

Write for someone who uses OpenClaw but has not read the code. The title and
opening problem statement should make sense without the diff or linked issue.

Required PR title:
type: <what changes for the person affected>
Types: feat, fix, improve, refactor, docs, chore.
Use a parenthesized scope only when it helps that reader.

Name the affected task and the symptom or outcome, not the implementation:
Good: fix: keep automations running when you open another chat
Bad: fix(cron): guard missing session IDs during authority restoration
Good: fix: let users sign in again after their session expires
Bad: fix(auth): add a null check to the token refresh handler

For internal-only work, name the actual developer or operator workflow affected.

For fork branch edits, follow CONTRIBUTING.md.
-->

## What Problem This Solves

<!--
Describe the concrete user, product, or operational problem.
In 1–3 plain sentences, say who is affected, what happens today, and why it
matters to them. For a bug, name the trigger if known. For a feature or internal
work, describe the need in the actual workflow without inventing harm.
Could a reader understand the problem without knowing your proposed fix?

Good: "Background checks can use up a new user's model allowance before they've
asked the assistant to monitor anything."
Bad: "Turn off periodic checks on fresh installs."
-->

## User Impact

<!--
What can the affected person do or expect after this change? Name any required
action and material risk, including breaking changes or migrations. For internal
work, describe the workflow outcome and say when there is no user-visible change.
-->

## Why This Change Was Made

<!--
Name the approach and why it fits this workflow. Explain a tradeoff if it
matters; leave file lists in the diff rather than restating the problem or outcome.
-->

## Evidence

<!--
Say what you checked, what you observed, and what remains unknown. If you did
not exercise the affected behavior, say so. Report inspection, focused tests,
and CI only for what they showed; a planned check is not a result. Keep gaps
visible and link long output. For visual changes, follow the PR visual-proof standard:
https://github.com/openclaw/openclaw/blob/main/.agents/skills/openclaw-pr-maintainer/references/media.md#pr-visual-proof
-->
