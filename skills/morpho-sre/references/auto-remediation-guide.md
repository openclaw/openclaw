# Auto Remediation PR

> Loaded on demand from morpho-sre skill. See SKILL.md for hard rules and routing.

Reference for creating automated fix PRs via `autofix-pr.sh`. Use this when confidence is high, patch scope is small, and validation passes.

## Prerequisites

Use this flow only when:

- Top hypothesis confidence is high (>= `AUTO_PR_MIN_CONFIDENCE`)
- Patch scope is small and reversible
- Validation command succeeds (lint/test/helm template/etc.)

## Usage

```bash
/home/node/.openclaw/skills/morpho-sre/scripts/autofix-pr.sh \
  --repo morpho-org/<repo> \
  --path /home/node/.openclaw/repos/morpho-org/<repo> \
  --title "fix(<scope>): <short-summary>" \
  --commit "fix(<scope>): <short-summary>" \
  --confidence 90 \
  --check-cmd "<targeted validation command>" \
  --body-file /tmp/sre-pr-body.md
```

## What autofix-pr.sh Enforces

- Repo allowlist (`AUTO_PR_ALLOWED_REPOS`)
- Confidence threshold (`AUTO_PR_MIN_CONFIDENCE`)
- Secret-pattern scan in staged diff before push
- Create/reuse Linear ticket when missing (`AUTO_PR_LINEAR_*`)
- Branch = Linear `branchName`
- Conventional PR title carries the Linear ticket scope token
- Authenticated push + `gh pr create`
- Tracking label `openclaw-sre` on PR (`AUTO_PR_TRACKING_LABEL`)
- Tracking label `openclaw-sre` on linked Linear tickets detected from branch/title/commit/body
- PR URL attachment + implementation comment back on the linked Linear ticket
- Slack DM warning to operator before PR creation (`AUTO_PR_NOTIFY_*`)

## PR Convention Requirements

- Always keep the same Linear/PR rule for tracking: branch/title must carry the Linear ticket key.
- Always add label `openclaw-sre`.
- Always add same label on linked Linear ticket:
  ```bash
  /home/node/.openclaw/skills/morpho-sre/scripts/linear-ticket-api.sh issue ensure-label <TICKET> openclaw-sre
  ```

## Linear Linking

For every incident follow-up that needs code/config work:

1. Create or reuse a Linear ticket first and mention it in-thread.
2. Any PR opened from incident follow-up must use the Linear ticket `branchName` as the branch.
3. Add the PR URL back to the ticket:
   ```bash
   /home/node/.openclaw/skills/morpho-sre/scripts/linear-ticket-api.sh issue add-attachment <TICKET> <PR_URL>
   ```

## When Gate Fails

- Report blocked reason and fallback manual next step.
- Reply with `*Suggested PR:* <repo> <path> <title> <validation>` and `*Linear:* <ticket | blocked reason>`.

## When Gate is Still Closed

If PR gate is still closed (confidence too low, validation fails, or repo not in allowlist):

- Do not open a PR.
- Instead, name 1-2 concrete PR candidates with repo/path/title/validation in the reply.
- Create or reference the Linear ticket for manual follow-up.
