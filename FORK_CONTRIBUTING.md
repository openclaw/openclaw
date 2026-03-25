# Fork PR Guide

Use this file when the PR target is the fork `artemgetmann/openclaw` and the base branch is either:

- `main`
- `codex/consumer-openclaw-project`

For upstream PRs to `openclaw/openclaw`, use `CONTRIBUTING.md` instead.

This fork guide exists for one reason: fast founder review. The upstream template is useful for broad OSS hygiene, but it is too noisy for day-to-day fork work where the change is usually discussed, implemented, and live-tested in the same loop.

## PR Goal

Make the PR easy to review in under two minutes.

The reviewer should be able to answer:

1. What exact user path got fixed?
2. What exact proof shows it worked?
3. What exact shared-state or runtime footgun got removed?
4. What still hurts?

If the PR body does not answer those four questions immediately, it is not ready.

## Required Top Block

Every fork PR should start with this section:

```md
## Review Fast Path

- User path fixed:
- Proof:
- Shared-state footgun removed:
- Still hurts:
```

Write this in plain language. Keep it tight. No filler.

Examples:

- `Telegram token verify -> first DM capture -> first reply starts -> reply lands in same DM`
- `runtime_ownership=ok`, real smoke passed, reply text returned
- `isolated Telegram lane no longer reuses shared OAuth refresh state`

## Recommended PR Shape

After `Review Fast Path`, keep the body to a few short sections:

```md
## Why This Matters

- ...

## Scope Boundary

- ...

## Verification

- ...

## AI Assistance

- AI-assisted
- Testing degree:
```

That is usually enough for fork PRs.

Do not blindly paste the full upstream PR template into fork PRs unless the target reviewer explicitly wants it.

## Verification Rules

Fork PRs should include exact proof, not vague confidence language.

Good proof:

- exact runtime ownership lines
- exact smoke command names
- exact test command names
- exact observed reply text or user-visible result
- exact blocker if live validation could not complete

Bad proof:

- `should work`
- `tested locally`
- `seems fixed`
- giant log dumps with no interpretation

## Scope Discipline

Fork PRs should stay focused on one user path or one operational hardening step.

State the boundary explicitly:

- what changed
- what did not change
- what pain still remains

If the branch mixes unrelated fixes, split it.

## Founder Review Mode

When the change was already discussed and live-tested in the same loop, review should be fast.

Default review flow:

1. Read `Review Fast Path`.
2. Confirm the proof is specific.
3. Skim only the risky files.
4. Merge.

## Files That Always Deserve a Real Look

Even in fast review mode, slow down if the PR touches:

- `AGENTS.md`
- `CLAUDE.md`
- prompt/bootstrap/system-prompt files
- auth/token storage
- runtime ownership, launch, or port selection
- scripts that assign or release Telegram bot claims
- shared-state fallback logic

These files can create fake-success bugs even when the surface behavior looks fine.

## AI Assistance Note

Keep this minimal:

- `AI-assisted`
- testing degree: `untested`, `targeted`, or `live-tested`

No essay needed.
