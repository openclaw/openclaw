## Decision Context

Record an optional `decision` beside `score` and `label` for surface and category
Quality/Completeness, or beside `supported` for category LTS. In `taxonomy.yaml`,
use optional `level_decision` beside the canonical surface `level`.

Each record contains `value`, `rationale`, `reviewer`, `evidence_refs`, and
`revalidate_when`. Use an integer from 0–100 for Quality/Completeness, a boolean
for LTS, and a declared taxonomy level ID for `level_decision`. Supply nonempty
text fields and at least one evidence reference. Name the actual reviewer and
the condition that should trigger another review.

Leave unavailable history absent: it is unknown, not an invitation to invent
reviewers, rationale, or evidence. A record does not overwrite the current score,
support flag, or canonical level. If its value differs, retain both; generated
docs show a non-gating mismatch, including under strict input validation.

Do not attach decisions to Coverage, computed rollups, surface LTS summaries, or
the copied level in score aggregates. Decision context does not change coverage
identity, score calculations, support commitments, or release gates.
