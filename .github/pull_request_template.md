# Pull Request Checklist

Story ID: `E#-F#-S#`

## PR title format

- Title must start with `E#-F#-S# <short verb phrase>`
- Example: `E1-F1-S1 add contracts package`

## Acceptance evidence

- Commands + exact output (or screenshots) proving acceptance criteria.
  - e.g. `node --test ...` output
- Required evidence for this story:
  - list and paste command outputs here

## Risk / rollback

- Risk flags, migration safety notes, and revert plan.
- If no migration was modified, explicitly state `No migration changes`.

## Checklist

- [ ] Story ID added in PR title
- [ ] DoD tests passing (attach command + result)
- [ ] Feature flag status documented (if used)
- [ ] Migrations are safe and rollback-safe
- [ ] Observability notes updated (`logs/metrics/traces` impacted)
- [ ] Rollback notes included
