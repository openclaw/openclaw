---
summary: "How Barnacle and ClawSweeper feedback helps move OpenClaw pull requests through review."
read_when:
  - Following up after Barnacle or ClawSweeper feedback
  - Asking ClawSweeper for review
  - Debugging Barnacle, ClawSweeper, stale labels, or auto-closures
title: "Pull request review flow"
sidebarTitle: "PR review flow"
---

This page explains the review flow after an OpenClaw pull request is open: what
Barnacle and ClawSweeper do, how to improve the PR from their feedback, and what
to check when nothing appears to happen.

Barnacle and ClawSweeper help maintainers keep the queue usable. They do not
replace maintainer judgment.

## Barnacle

Barnacle is deterministic GitHub triage. It looks for known queue-management
cases and responds with labels, comments, or closures.

Barnacle may act when:

- a PR body is mostly empty or missing problem context;
- a PR has no useful evidence;
- a docs-only, test-only, refactor-only, CI-only, or infra change lacks linked
  maintainer context;
- a change looks like it belongs in ClawHub or a plugin instead of core;
- a branch carries unrelated work;
- an author has more than 20 open PRs;
- an issue or PR has gone stale.

Barnacle runs from trusted repository workflow code. It does not check out or
run contributor code.

Most routing labels are maintainer or automation signals. Contributors do not
need to add labels themselves.

## ClawSweeper

ClawSweeper is the AI-assisted review and maintenance bot for OpenClaw
repositories. It can review PRs, assess proof, leave durable review comments,
and help maintainers with guarded repair or automerge flows.

ClawSweeper is queue-based. Do not expect an immediate response after opening a
PR, pushing a commit, or asking for review. Label updates after a ClawSweeper
run can also take time.

ClawSweeper is triggered when a PR is opened. If you have updated your branch,
PR description, proof, or code, ask ClawSweeper for another review by commenting
on the PR:

```text
@clawsweeper re-review
```

`@clawsweeper review` and `/review` are also routed to ClawSweeper. Be patient:
asking again before the requested changes are present just adds queue noise.

If ClawSweeper leaves review conversations, handle them like normal review
feedback:

- push the code change or update the PR description;
- add evidence when it asks for proof;
- resolve addressed review conversations;
- reply and leave a conversation open only when you need maintainer judgment;
- ask for another re-review only after the PR is current.

If a human contributor or maintainer has taken over the PR and is actively
working on it, do not summon ClawSweeper or otherwise work on the PR at the same
time. Let the human review or repair finish first. If activity stops, check
whether the author was asked for proof or other work.

## Improve a PR during review

1. Open a focused PR.
2. Fill in the PR template with the problem, the change, user impact, and
   evidence.
3. CI runs.
4. Barnacle may label, comment, or close obvious queue-management cases.
5. ClawSweeper reviews the PR automatically the first time, or after a review
   request.
6. Read ClawSweeper's `Rank-up moves:` and `Proof guidance:` as the action list
   for that PR. Ratings and labels are review signals, not fixed merge targets.
7. Update the branch and PR description, resolve addressed bot issues, and ask
   for a re-review when ready. A few update and review cycles between the
   author, maintainer, and ClawSweeper are normal.
8. Keep discussion on the PR when possible. Move to `#clawtributors` on Discord
   only when the PR needs maintainer coordination, automation appears blocked,
   or the next decision is hard to settle in GitHub comments. Include the PR
   link, current status, and the specific question or remaining evidence.
9. A maintainer reviews the PR, CI, bot feedback, and evidence, and can
   eventually merge the PR.

Keep the PR body current. Comments are useful for discussion, but the PR
description is the durable summary maintainers and automation come back to.

Useful evidence includes focused test output, CI results, screenshots,
recordings, terminal output, live observations, redacted logs, or artifact
links. For visual changes, include before and after screenshots when practical.
For proof files, prefer linking CI artifacts, GitHub-uploaded screenshots or
recordings, or a short redacted log excerpt. Do not commit generated proof files
unless they are part of the actual docs, tests, or product change.

Redacting sensitive data is the contributor's responsibility. Remove secrets,
tokens, private URLs, user data, and unrelated logs before posting proof.

OpenClaw also uses stale automation. Unassigned issues and PRs can be marked
stale after inactivity, then closed if they remain idle. Assigned PRs use a
longer stale window, but normal updates may not reset that timer. If an assigned
PR is still active, coordinate with the maintainer working on it.

## When automation stays quiet

Automation may stay quiet when a maintainer is already handling the item, a
request is still queued, the event is routine, or the ClawSweeper lane is not
configured for the requested action.

It may also avoid action when a trusted workflow would need to run untrusted
contributor code. In that case, maintainers use normal review or a safer
workflow instead.

## Troubleshooting

If ClawSweeper does not respond immediately, wait before retrying. The service is
queue-based, and repeated comments or label changes can make the thread harder
to review without making the queue faster.

Before asking for help, check:

- the PR description is current;
- the latest commit contains the requested change;
- CI has finished, or the remaining failure is relevant to the question;
- the review request was made as a PR comment:
  `@clawsweeper re-review`;
- a maintainer or contributor is not already actively working on the PR;
- the request is not still within the normal ClawSweeper queue delay.

If there is still no ClawSweeper response after several hours, or if the PR
appears blocked by automation, ask in `#clawtributors` on Discord. Include the
PR link, what you expected, when you asked, and what changed since the last bot
comment.

## Forking the automation

ClawSweeper is open source and can be forked for other repositories:

- [openclaw/clawsweeper](https://github.com/openclaw/clawsweeper)
- [ClawSweeper docs](https://clawsweeper.bot/)

## Related

- [Contributing](https://github.com/openclaw/openclaw/blob/main/CONTRIBUTING.md)
- [CI pipeline](/ci)
- [Mantis](/concepts/mantis)
- [ClawSweeper](https://clawsweeper.bot/)
