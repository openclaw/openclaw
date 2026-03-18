---
name: sre-auto-remediation
description: "Use when creating auto-fix PRs from incident findings, linking PRs to Linear tickets, or managing the autofix-pr.sh pipeline. Covers confidence gates, repo allowlists, secret scanning, and PR conventions."
metadata: { "openclaw": { "emoji": "🔧" } }
---

# SRE Auto Remediation

Companion skill to `morpho-sre`. Load `morpho-sre` for hard rules, paths, and knowledge surfaces.

Reply with conclusions only in ALL communications — Slack, DMs, PR comments, Linear comments, every output surface. No investigation steps, intermediate reasoning, or tool output summaries. All investigation work happens silently; only the final summary is sent.

## When to Use

- Top hypothesis confidence is high (>= `AUTO_PR_MIN_CONFIDENCE`)
- Patch scope is small and reversible
- Validation command succeeds (lint/test/helm template/etc.)
- Incident follow-up requires a code/config fix PR
- Need to link a PR to a Linear ticket with proper conventions

## Prerequisites

Before opening any PR:

1. Prove the target repo/path changes the active code path. If you cannot name the path, do not open the PR.
2. Have at least one successful live check supporting the hypothesis.
3. For stale-row/write-path theories, include one live DB row/provenance fact.
4. For rewards/provider incidents, verify upstream provider/API response first.

## autofix-pr.sh Usage

Path: `/home/node/.openclaw/skills/morpho-sre/scripts/autofix-pr.sh`

### Full Usage

```bash
autofix-pr.sh \
  --repo morpho-org/<repo> \
  --path /home/node/.openclaw/repos/morpho-org/<repo> \
  --title "fix(<scope>): <short-summary>" \
  --commit "fix(<scope>): <short-summary>" \
  --confidence 90 \
  --check-cmd "<targeted validation command>" \
  --body-file /tmp/sre-pr-body.md
```

### What the Script Enforces

| Gate                 | Description                                                                |
| -------------------- | -------------------------------------------------------------------------- |
| Repo allowlist       | Only repos in `AUTO_PR_ALLOWED_REPOS` are accepted                         |
| Confidence threshold | Must meet `AUTO_PR_MIN_CONFIDENCE` (numeric)                               |
| Secret scan          | Scans staged diff for secret patterns before push                          |
| Linear ticket        | Creates or reuses Linear ticket when missing (`AUTO_PR_LINEAR_*`)          |
| Branch naming        | Branch = Linear `branchName` from the linked ticket                        |
| PR title             | Conventional format carrying the Linear ticket scope token                 |
| Auth                 | Authenticated push via GitHub App + `gh pr create`                         |
| Tracking label       | Adds `openclaw-sre` label on PR (`AUTO_PR_TRACKING_LABEL`)                 |
| Linear label         | Adds `openclaw-sre` label on linked Linear tickets                         |
| Linear attachment    | Attaches PR URL + implementation comment back to the ticket                |
| Operator notify      | Sends Slack DM warning to operator before PR creation (`AUTO_PR_NOTIFY_*`) |

### Repo Bootstrap

For PR work, use `autofix-pr.sh` which handles all auth and repo bootstrap. Do not attempt manual `git clone` + `git push` + `gh pr create`.

If mapped path has no `.git`, the script calls `repo-clone.sh --image <workload>` to create a proper clone.

## PR Convention Requirements

- Branch = Linear ticket `branchName` (get via `linear-ticket-api.sh issue get-branch <TICKET>`)
- PR title = conventional format with Linear ticket key in scope (e.g., `fix(PLA-870): description`)
- Always add label `openclaw-sre` on the PR
- Always add label `openclaw-sre` on the linked Linear ticket:

```bash
linear-ticket-api.sh issue ensure-label <TICKET> openclaw-sre
```

- PR body: concise and reviewable; never paste raw command output, manifests, or log dumps

## Linear Ticket Integration

Always create or reuse a Linear ticket before opening a PR:

```bash
# Create ticket
linear-ticket-api.sh issue create \
  --title "fix: short description" \
  --file /tmp/ticket-body.md \
  --team Platform \
  --project "[PLATFORM] Backlog" \
  --assignee florian \
  --state "In Progress" \
  --priority 2 \
  --labels "openclaw-sre|Bug"

# Get branch name for the PR
linear-ticket-api.sh issue get-branch PLA-XXX

# After PR is created, attach URL back
linear-ticket-api.sh issue add-attachment PLA-XXX https://github.com/morpho-org/repo/pull/123

# Ensure tracking label
linear-ticket-api.sh issue ensure-label PLA-XXX openclaw-sre
```

## When Gate Fails

If the confidence gate or any other gate fails:

1. Report the blocked reason in the incident thread
2. Include the manual fallback next step
3. Reply with: `*Suggested PR:* <repo> <path> <title> <validation>` and `*Linear:* <ticket | blocked reason>`
4. Do not open the PR manually -- wait for the gate condition to be met

## When NOT to Open a PR

- Confidence below `AUTO_PR_MIN_CONFIDENCE`
- Cannot name the exact repo/path that changes the active code path
- For stale-row/write-path theory without live DB row/provenance fact
- For blacklist/config-only fix where the live failing path does not consume that config
- No successful live check supports the hypothesis

In these cases, name the PR candidate (repo, path, title, validation) in the thread reply and let a human decide.

## Reference

See `morpho-sre/references/auto-remediation-guide.md` for the full auto-remediation playbook.
