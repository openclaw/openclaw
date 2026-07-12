# Specification Analysis: HO-2417

## Requirement Coverage

| Requirement                        | Task       |
| ---------------------------------- | ---------- |
| Bridge-only exemption              | T001, T002 |
| Unsafe-local preservation          | T003       |
| Ordinary stale entity preservation | T003       |
| Validation                         | T004       |

## Quality Check

- Fatal: 0
- Critical: 0
- Missing part: none
- Ambiguity Count: 0
- UI evidence: N/A. This change has no UI, route, or snapshot surface.
- Async lifecycle ownership: N/A. The lint operation is bounded local analysis
  and does not acquire or transfer pipeline ownership.
- UI applicability: UI N/A. `stale-page` is a lint rule identifier; there is
  no assignee-visible screen or visual-review surface.
