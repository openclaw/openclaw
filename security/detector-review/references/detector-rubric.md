# Detector Rubric

Use this rubric before writing any detector.

## Quick Choice

| Detector                    | Use when                                                                                                                                                         | Good signs                                                                                                                                                                  | Reject when                                                                                                             |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Precise OpenGrep rule (`A`) | The bug has a high-confidence local shape. Prefer same-family variant detection, but accept a labelled regression canary when generic detection is not feasible. | Dangerous API is explicit, missing guard is visible in the AST, taint source→sink is clear, or an exact vulnerable pattern can be anchored with near-zero fixed-side noise. | The only possible rule is broad name-matching, misses the vulnerable commit, or fires only on fixed/safe functionality. |
| Custom CodeQL (`B`)         | The bug depends on flow through wrappers, helper chains, trusted vs untrusted value movement, or source-to-sink reachability.                                    | You can name sources, sinks, and maybe barriers in one sentence. The behavior survives renames and helper indirection.                                                      | The logic is mostly state-machine, retry, race, or product policy, with no stable dataflow story.                       |
| Broad OpenGrep (`C`)        | Precise detection is hard, but broad highlighting can show suspicious code for human review.                                                                     | You can ask a wide question like "where do privileged routes skip the normal auth helper?" or "where do we fetch URLs outside the guarded helper?".                         | The rule would effectively match the entire codebase or cannot be reviewed meaningfully by a human.                     |

## Decision Rules

Pick `A` only if all of these are true:

- it catches the original vulnerable commit or a documented additive-fix positive
- it is silent on the fixed commit, or every fixed-side finding is explicitly classified as a real residual bug / known false positive / expected review-aid hit
- it misses at least one close safe control
- its repo findings are reviewed and defensible as real regressions, verified variants, or intentional review-aid findings
- if it is only an exact regression detector, it is labelled as a regression canary rather than a reusable family detector

If you pick `A`, decide between **`mode: taint`** and a syntactic `patterns:` rule:

- **Default to taint mode** if the bug can be expressed as "untrusted X reaches dangerous Y unless it goes through helper Z". Taint mode tracks values through assignments and aliases, respects sanitizers automatically, and produces ~100× less noise than syntactic rules in real codebases. See the spec's "How to write rule `A`" subsection for the skeleton.
- **Use syntactic `patterns:` only** when the bug is a single AST shape with no dataflow (e.g. an exact API called with literal `false` for an auth flag), when there is no meaningful sanitizer to consult, or when the dangerous shape is the absence of a check rather than data flowing somewhere.

Pick `B` only if all of these are true:

- the vulnerability can be described as lower-trust data reaching a sink AND
- intra-file OpenGrep taint is not enough — typically because the flow crosses files, requires type-aware analysis, or needs sophisticated barrier semantics that OpenGrep can't express
- you can define or approximate barriers without encoding the exact advisory diff

(If a single-file OpenGrep taint rule would do the job, prefer that over CodeQL — it ships with the same rulepack and runs in the same workflow.)

Pick `C` when at least one of these is true:

- semantic intent matters more than local syntax
- exact correctness requires human review
- you still want a cheap "show me suspicious shortcuts" pass

Pick none of `A`, `B`, `C` when the bug is primarily:

- stale state or reload behavior
- race or interleaving sensitive
- approval or policy logic with no stable local shape
- product-trust semantics better enforced by tests or runtime assertions

## Validation Bar

`A` precise OpenGrep rule:

- hit the original vulnerable commit changed files (or document additive-fix exception)
- scan the fixed commit changed files and classify any remaining hits
- miss close negative / safe control
- scan repo/HEAD
- classify repo hits as `real regression`, `verified variant`, `known false positive`, or `review-aid noise`

`B` CodeQL query:

- hit positive fixture or recovered vulnerable path
- miss safe control
- run on repo or targeted database when feasible
- explain sources, sinks, and barriers in plain English

`C` broad OpenGrep rule:

- hit positive
- run on repo
- show the user a small reviewed sample of findings
- explicitly label it as `review aid` if noise is expected

## Anti-Patterns

Do not ship:

- file-path-anchored rules unless the path names the public boundary itself
- one-off identifier matching with no semantic value
- exact-regression rules disguised as reusable family detectors
- CodeQL queries that only restate a built-in query with zero narrowing
- broad OpenGrep rules that match every handler, every fetch, or every exec
