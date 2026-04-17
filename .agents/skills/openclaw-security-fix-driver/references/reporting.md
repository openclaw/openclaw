# Manager-facing Summary Template

The report is what the manager sees. Keep it short, plain-English, and linkable. The target reader is a busy manager who wants to know in 60 seconds: what was broken, what you changed, why it's safe, and where the proof is.

Save one file per merged fix to:

```
.agents/state/security-fix-driver/reports/<issue-number>.md
```

And update the rolling index at:

```
.agents/state/security-fix-driver/reports/INDEX.md
```

## Per-fix report template

```markdown
# Issue #<N> — <short title>

**Surface:** <e.g. gateway ingress / pairing / webhook HMAC / plugin auth>
**Severity:** <critical | high | medium | low> (score <0-28>)
**Shipped tags affected:** <list of tags, or "main only">
**PR:** <url>
**Landed commit:** <sha link>
**Merged:** <iso date>

## What was broken

2–4 sentences in plain English. Name the trust boundary that was crossed. No jargon the manager would have to look up.

## Why it matters

1–2 sentences on who could exploit it and what they could gain. If exploitability is low, say so and why (e.g., "requires paired device already" or "defense in depth only").

## The fix

3–5 sentences describing the change. Use repo-root-relative file paths, e.g. `src/gateway/auth.ts:142`. Explain **why this fix is minimal and correct**, not every line of the diff.

## Why this fix works

One paragraph. The goal is to convince a reader that the fix actually closes the trust boundary rather than papering over a symptom. Reference the specific guard added and the invariant it enforces.

## Risk and rollback

One paragraph. What adjacent behavior could regress, and what tests cover it. How to roll back if needed (usually: revert the merge commit, which the landed-commit link above points to).

## Verification

- Unit tests: `<list of new/updated tests with file:line>`
- Local gates: `pnpm test <filter>` ✓, `pnpm check` ✓, `pnpm build` <✓ or n/a with reason>
- CI: <link to the green run>
- Manual verification: <only if applicable, 1 line>

## Reporter credit

<GitHub handle and link, only if the reporter is listed publicly on the issue. Omit entirely for private advisories unless the reporter has given explicit permission; when in doubt, defer to `$openclaw-ghsa-maintainer`.>
```

## INDEX.md template

The index is a running table. Sort newest-merged first so the manager sees the latest work at the top.

```markdown
# OpenClaw Security Fix Campaign — Index

| Date | Issue | Surface | Severity | PR | Report |
| ---- | ----- | ------- | -------- | -- | ------ |
| 2026-04-16 | #68123 | gateway ingress | high (24) | [#68156](https://github.com/openclaw/openclaw/pull/68156) | [68123.md](./68123.md) |
| 2026-04-15 | #67994 | pairing          | medium (16) | [#68041](https://github.com/openclaw/openclaw/pull/68041) | [67994.md](./67994.md) |

_Last updated: <iso date>_  Campaign start: <iso date>  Fixes landed: <N>  In-flight: <M>
```

## Writing rules

- **One page, not three.** If the report runs past one screen, trim it.
- **Plain English.** The phrase "unauthenticated remote attacker" is fine. The phrase "byzantine adversary under standard model" is not.
- **Link, do not paste.** Link to the PR, the commit, the issue, the CI run. Do not paste diffs into the report.
- **No live secrets, no real phone numbers, no real user data.** Placeholders only, per `CLAUDE.md`.
- **Attribute reporters correctly.** For public issues, credit the reporter by GitHub handle if they were publicly involved. For GHSA-private flow, credit is owned by `$openclaw-ghsa-maintainer`, not by this report.
- **No speculation about attacker identity or intent.** Stick to what the code does and what the fix changes.

## When to batch reports

If a single issue caused multiple PRs (for example, the fix needed a core change and a channel plugin change), make one report that lists all PRs in the **PR** line and walks through both changes in **The fix**. Do not write a separate report per PR.

If a single PR fixes multiple linked issues, write one report filed under the lowest issue number, and cross-link from the other issue numbers' reports with a one-line pointer: `See [./<lowest>.md](./<lowest>.md)`.
