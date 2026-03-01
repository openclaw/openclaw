# Agent Submission Control Policy (Mandatory)

**Applicability:** This policy applies to all accounts that are not project maintainers or recognized contributors, including autonomous agents and bot-operated accounts.

### 1) Open Item Quota (MUST)

Non-maintainer/non-contributor accounts **MUST NOT** have more than **10** combined open repository items at any time:

`open_items = open_pull_requests + open_issues`

If `open_items >= 10`, the account **MUST NOT** open any new PR or Issue until count is reduced below 10.

### 2) Pre-Submission De-duplication (MUST)

Before opening a PR or Issue, the submitting account **MUST** search existing repository history for duplicates, including:

- open PRs and Issues,
- closed PRs and Issues,
- recently merged fixes touching similar files, symptoms, or root cause.

### 3) Duplicate Handling (MUST NOT / MUST)

If a likely duplicate exists, the account:

- **MUST NOT** open a new PR or Issue,
- **MUST** add a 👍 reaction to the existing relevant thread,
- **MAY** add a concise comment only if it contributes materially new evidence.

Near-duplicate submissions, "me too" PRs, and cosmetic variants are prohibited.

### 4) Anti-Spam Constraint (MUST NOT)

Accounts **MUST NOT** engage in high-volume speculative submissions, shotgun patching, or minor-variation flooding intended to maximize output over quality.

### 5) Enforcement and Penalties

Violation of any requirement in this policy is enforceable at maintainer discretion, including immediate closure without review.

Bots/agents that:

- repeatedly submit duplicates, or
- exceed the quota, or
- evade this policy through account rotation or minor-variation reposting

are subject to **permanent ban**.

### 6) Maintainer Override

Maintainers may apply stricter limits, temporary freezes, labeling controls, or participation restrictions at any time to protect review capacity and repository health.

### 7) Mandatory Agent Signoff (MUST)

All bot/agent-created PRs, Issues, and comments **MUST** end with:

`Agent-Signoff: <lobster-name-or-pun>`

Rules:

- **MUST** be plain text in the visible body.
- **MUST** be present exactly once.
- **MUST NOT** impersonate a human.
- Missing/invalid signoff = policy violation.

Enforcement:

- Non-compliant submissions may be closed/removed immediately.
- Repeated violations by a bot/agent are grounds for **permanent ban**.

Style note (optional):

- Agent-authored submissions are encouraged to use a playful lobster-themed voice when helpful.
- Keep technical content clear and concise; this does not relax any MUST/MUST NOT requirements above.
