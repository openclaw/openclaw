# GHSA Detector Review Report Template

Use this template for `.tmp/ghsa-detector-review/<ghsa>/report.md`.

```md
# <GHSA> Detector Review

## Advisory

- GHSA: `<GHSA>`
- URL: `<url>`
- Fix commit: `<sha>`
- Vulnerable commit or tree state: `<sha or description>`

## Vulnerable Code

- File: `<path>`
- Vulnerable snippet summary: `<1-3 lines>`
- Fixed snippet summary: `<1-3 lines>`

## Root Cause

- Input: `<lower-trust input>`
- Sink: `<privileged sink>`
- Missing or wrong guard: `<guard or semantic mismatch>`
- Why this bug exists: `<tight explanation>`

## Detector Decision

| detector              | decision | why     |
| --------------------- | -------- | ------- |
| `A` reusable OpenGrep | yes/no   | `<why>` |
| `B` custom CodeQL     | yes/no   | `<why>` |
| `C` broad OpenGrep    | yes/no   | `<why>` |

## Artifacts

- `A`: `<path or none>`
- `B`: `<path or none>`
- `C`: `<path or none>`

## Validation

### `A` reusable OpenGrep

- positive: `<pass/fail/not run>`
- family-variant positive: `<pass/fail/not run>`
- negative: `<pass/fail/not run>`
- repo scan: `<summary>`

### `B` custom CodeQL

- positive: `<pass/fail/not run>`
- negative: `<pass/fail/not run>`
- repo scan or targeted db: `<summary>`

### `C` broad OpenGrep

- positive: `<pass/fail/not run>`
- repo scan: `<summary>`
- manual review value: `<why>`

## Recommendation

- Best detector for this bug family: `<A/B/C/none>`
- Why: `<short explanation>`
- Next follow-up: `<rule pack, query pack, tests, or runtime assert>`
```
