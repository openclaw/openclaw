# Importance Ranking Rubric

The goal of the ranking step is a **deterministic, explainable** ordering of open security issues so reviewers can see why issue A is above issue B. Never present a score without the component breakdown.

Ranking runs in two passes. **Pass 1** is the cheap candidate sweep from the ranker script — it uses labels, title/body keywords, and surface mentions, and emits a preliminary score. **Pass 2** is the deep read that actually decides the rank: load the full issue body + comments + any linked GHSA, evaluate the signals below, and re-score. Pass-1 is a filter to avoid reading 5,000 issues; Pass-2 is where the real judgment happens. Labels alone never decide the rank.

## Score formula

`total = severity + exploitability + blast_radius + recency + surface_sensitivity`

Range: 0 – 28. Tie-break order: `surface_sensitivity`, then `severity`, then oldest `updatedAt`.

## Deep-read signals (Pass 2)

Before touching numbers, read the issue body, all comments, and any linked GHSA. The signals below adjust score components up or down and, more importantly, tell you whether the issue is a real trust-boundary bug, a hardening suggestion, or noise.

### Promotion signals (push a candidate up)

- **Named trust-boundary crossing** — the body explicitly describes crossing unauth → auth, LAN → loopback, plugin → core, untrusted input → privileged execution, sandbox → host, or similar. "Boundary" language, not just "exploit."
- **Concrete code pointer** — a specific file, function, or line number whose current behavior you can verify. Bonus if the pointer is inside a path in security `CODEOWNERS`.
- **Reproducer present** — a script, curl, request payload, or test case that demonstrates the flaw. Reports with reproducers are both higher-severity in expectation and lower-risk to fix (you can validate the fix against the repro).
- **CVSS vector string** (e.g. `CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H`) — treat the base score as authoritative for the `severity` component.
- **Present in latest shipped tag** — verified via `git show <tag>:<path>`. Raises the `recency` component; "only in `main`" lowers it.
- **Experienced reporter context** — prior valid advisories from the same reporter, references to upstream CVEs, linked academic/industry disclosures. Not a score bump by itself, but raises confidence when the body is otherwise terse.
- **Missing security label, but body is clearly a security report** — promote the candidate even though label-only discovery would miss it. This is one of the most common cases.

### Demotion signals (push a candidate down or to skip)

- **Hardening-only framing** — the body says "defense in depth", "additional layer", or proposes tightening an already-enforced guard with no described bypass.
- **Vague "could be exploited" without a mechanism** — no file, no call path, no payload. Demote until the reporter supplies specifics; do not invent a mechanism to justify the rank.
- **Trust-model mismatch** — the report's precondition is "attacker has operator admin", "attacker has root on the host", or "attacker has already paired their device." Those are already-trusted positions per `SECURITY.md`; demote hard.
- **Out-of-scope classes** (disqualifiers, below) — private-LAN `ws://`, prompt injection in workspace memory files, same-user process boundary on a developer machine. Zero the score and route to `$security-triage`.
- **Already fixed on the latest shipped tag** — verify with `git tag --contains <fix-commit>` if the report names one, or `git show <tag>:<path>` to inspect. Close as "fixed pre-release."
- **Security-labeled but actually UX** — a `security` label applied during triage on something that turns out to be a usability or error-message concern. Remove from the campaign.
- **Speculation about attacker motives** — "an attacker could want to..." with no concrete path. Lower confidence; re-read for a real mechanism before scoring.

### Content the ranker script cannot see by itself

The Pass-1 helper is a keyword + label scan. It will miss:

- Reports filed as `bug` or `question` that are actually security issues
- Security reports whose title is generic (e.g. "WhatsApp reply goes to wrong chat") but whose body describes a routing-integrity bypass
- Issues whose severity is only visible in a long comment thread
- Duplicate chains where the original and most informative report lives on a different issue number

Pass 2 catches these. Always read the body and comments, not just the title and labels.

## Components

### 1. Severity (0 – 10)

Prefer explicit signals in this order:

1. CVSS score from the issue body or linked GHSA (use the `Base Score` as-is, rounded to int)
2. Repo labels: `severity:critical` = 9, `severity:high` = 7, `severity:medium` = 5, `severity:low` = 3
3. Keyword fallback on title/body: `RCE`, `auth bypass`, `privilege escalation`, `secret leak` → 8; `DoS`, `info leak` → 5; `hardening`, `defense in depth` → 2

### 2. Exploitability (0 – 5)

How easy is it to reach from an attacker's likely position?

| Score | Meaning |
| ----- | ------- |
| 5 | Unauthenticated remote (public ingress, no pairing) |
| 4 | Authenticated remote (paired device / operator token) |
| 3 | Local LAN with same-host pairing |
| 2 | Local same-user process boundary |
| 1 | Requires already-trusted plugin or operator-admin |
| 0 | Requires physical access or developer-only flag |

`CLAUDE.md` trust model is explicit that `ws://` on private LAN is allowed and **not** a vulnerability on its own. Passive LAN observation alone scores 0 here.

### 3. Blast radius (0 – 5)

How many users / channels / surfaces does the bug affect?

| Score | Meaning |
| ----- | ------- |
| 5 | All users on all channels (core gateway, auth, session, shared tool) |
| 4 | All users on one major channel (WhatsApp, Telegram, Slack, Discord, iMessage) |
| 3 | Most users on an optional channel (Matrix, Signal, Feishu, etc.) |
| 2 | One plugin / one provider |
| 1 | Opt-in feature, small cohort |
| 0 | Dev-only or test-only path |

### 4. Recency / age (0 – 3)

Older unpatched issues on shipped tags are worse, not better.

| Score | Meaning |
| ----- | ------- |
| 3 | Open > 60 days and present in latest shipped tag |
| 2 | Open 30 – 60 days and present in latest shipped tag |
| 1 | Open < 30 days and present in latest shipped tag |
| 0 | Only present on `main`, not in any shipped tag (still real, just lower campaign priority) |

Verify "present in latest shipped tag" with `git tag --sort=-creatordate | head -1` then `git show <tag>:<path>`.

### 5. Surface sensitivity (0 – 5)

Does the touched code sit on a security-critical surface?

| Score | Surface |
| ----- | ------- |
| 5 | Auth, pairing, device identity, signature verification, secret storage |
| 4 | Gateway ingress, protocol handshake, trusted-proxy, webhook HMAC |
| 3 | Sandboxing, command policy, approval handlers |
| 2 | Channel outbound (reply routing, recipient resolution) |
| 1 | Provider runtime (model auth forwarding, usage endpoints) |
| 0 | Docs, tests, developer tooling |

Cross-check `CODEOWNERS` for the touched path. Anything in a security-focused `CODEOWNERS` entry should not go below 3 here.

## Disqualifiers (score to 0, skip)

Even if a report scores high on paper, route to `$security-triage` and skip this campaign if any apply:

- Report is about `ws://` on private LAN pairing without a real trust-boundary bypass (explicitly out of scope per `CLAUDE.md`)
- Report is about prompt injection in user-owned workspace memory files (out of scope per `SECURITY.md`)
- Report's prerequisite is "attacker already has operator admin" (already-trusted)
- Duplicate of an existing open or fixed issue
- Fixed before the latest shipped tag (close as "fixed pre-release")

## Worked examples

### Example A — Unauthenticated webhook signature bypass

- CVSS 8.1 → severity 8
- Public ingress, no auth → exploitability 5
- All users on all webhook channels → blast radius 5
- Open 45 days, present in latest tag → recency 2
- Webhook HMAC is on gateway ingress → surface 4
- **Total: 24**

### Example B — Hardening: add CSRF token to an internal admin form

- `hardening` label → severity 2
- Local admin only → exploitability 1
- Opt-in admin UI → blast radius 1
- Open 15 days, only on `main` → recency 0
- Approval handler surface → surface 3
- **Total: 7**

### Example C — Prompt injection marker in a shared workspace memory file

- Keyword "injection" suggests 5, but `SECURITY.md` marks this class out of scope → disqualifier triggers, **total 0**, route to `$security-triage`.

## Presenting the rank to the user

Always show the top 10 in chat with this shape:

```
#1  issue 68123  total=24  sev=8 expl=5 blast=5 recency=2 surface=4
    Unauthenticated webhook signature bypass (src/webhooks/verify.ts)
    https://github.com/openclaw/openclaw/issues/68123
#2  ...
```

Full JSON goes into the ledger. Ranks never change mid-campaign unless the user asks to re-rank; new issues filed during the campaign are appended at the end of the queue.
