# GHSA Detector Review — Specification

This document is the agent-agnostic specification for one-advisory detector
work. It is intended to be consumed directly by any coding-harness agent
(Rovo Dev, Claude Code, Codex, OpenCode, ...) when invoked by the runner at
`scripts/run-ghsa-detector-review-batch.mjs`, or installed into a harness as
its native skill/prompt format.

> **For harness implementers**: this spec replaces what used to be an
> Anthropic-style `SKILL.md` under `~/.rovodev/skills/`. The runner now
> resolves it as `security/detector-review/detector-review-spec.md` from the
> repo root and includes its path verbatim in the per-case prompt. If you
> want to install it as a native skill in your harness of choice, copy the
> body of this file (without this header block) into the appropriate slot.

Goal: turn a single GHSA into a **high-confidence** detector. Best case: a
variant detector that finds real, verified same-family bugs. Minimum acceptable
case: a precise regression detector that catches the original vulnerable pattern
and is silent on the fixed pattern. Do not trade accuracy for breadth.

## Inputs

- a `GHSA-...` id, advisory URL, or CVE tied to a GitHub advisory
- a local git checkout with enough history to inspect the fix
- OpenGrep and CodeQL if installed; if not, still do the analysis and mark missing validation clearly

## Output Contract

Produce all of these:

1. exact fix commit and exact vulnerable commit or vulnerable tree state
2. a short root-cause analysis tied to real code
3. a detector decision for:
   - `A`: reusable high-value OpenGrep rule
   - `B`: reusable CodeQL query
   - `C`: broader OpenGrep heuristic for manual review
4. any rules or queries that passed the decision bar
5. validation results for every produced artifact

If `A`, `B`, or `C` is not appropriate, say that explicitly and explain why.

## Start by Creating a Case Workspace

From the repo root, create a scratch workspace:

```bash
python3 security/detector-review/scripts/init_case.py GHSA-xxxx-xxxx-xxxx
```

This creates `.tmp/ghsa-detector-review/<ghsa>/` with a report skeleton plus folders for OpenGrep and CodeQL artifacts.

## Step 1: Recover the Exact Vulnerable Commit

Do not reason from the advisory text alone. Recover the real code.

Preferred sequence:

1. Fetch the advisory body.
2. Identify the fixing commit, linked PR, or linked patch.
3. Inspect the fixing diff.
4. Identify the vulnerable state:
   - usually `fix_commit^`
   - if the advisory fix spans multiple commits, identify the last vulnerable commit that still contains the exploitable behavior
5. Record exact file paths and the vulnerable and fixed snippets.

Useful commands:

```bash
gh api /repos/<owner>/<repo>/security-advisories/<GHSA>
gh search prs --repo <owner>/<repo> --match title,body,comments -- "<GHSA>"
git log --oneline --decorate --grep '<GHSA>'
git show <fix-commit>
git show <fix-commit>^:<path/to/file>
git show <fix-commit>:<path/to/file>
```

If the advisory does not name the fix directly, search by:

- GHSA id
- CVE id
- key vulnerable function names
- neighboring PRs or issue links

Do not guess. If commit recovery is uncertain, say so and explain the ambiguity.

## Step 2: Analyze the Vulnerability from Code

Describe the bug in terms of code, not prose.

At minimum, capture:

- attacker-controlled or lower-trust input
- privileged sink or dangerous behavior
- missing guard, wrong guard, or semantic mismatch
- whether the bug is mostly:
  - local structural
  - source-to-sink semantic
  - stateful / lifecycle / auth model

Keep this tight. The purpose is detector choice.

## Step 3: Decide What Is Detectable

Read `security/detector-review/references/detector-rubric.md` before choosing detectors.

Decide separately for:

- `A` reusable OpenGrep rule:
  - only when the pattern is structural and high-value beyond this one advisory
  - the rule should plausibly catch non-identical but similar vulnerabilities from the same bug family
  - avoid exact-match rules tied to one file, one identifier, or one repo-specific string unless that string is itself the dangerous API boundary
- `B` reusable CodeQL query:
  - use when wrapper traversal, source-to-sink flow, or trust-boundary semantics matter
- `C` broad OpenGrep heuristic:
  - use when precise detection is unrealistic but broad highlighting can surface suspicious code for human review

If the class is mainly auth-state, state-machine, or lifecycle behavior, it may deserve:

- no detector
- invariant tests
- runtime assertions

That is an acceptable outcome. Say it plainly.

## Step 4: Produce Only the Right Artifacts

Artifacts live under `.tmp/ghsa-detector-review/<ghsa>/`.

Rules:

- Keep `A` and `C` separate. One is a reusable high-value rule; the other is intentionally broader.
- Keep CodeQL in its own query file with a short comment describing sources, sinks, and barriers.
- Build small positive and negative fixtures when repo scanning alone is too ambiguous.
- Prefer minimal fixtures that preserve the real vulnerability shape.
- For `A`, add at least one same-family positive that is not just a copy of the advisory snippet with renamed variables. Change the API shape, helper shape, or surrounding control flow enough to prove the rule is not just an exact regression matcher.

### How to write rule `A` — prefer taint mode when there is dataflow

Before writing a syntactic `patterns:` rule, ask:

> Can I describe the bug as **"untrusted X reaches dangerous Y unless it goes through helper Z"**?

If yes (path/url/cwd/identifier/handle/secret reaches a string-concat sink, a `fetch()`, an `exec()`, a prompt, etc., unless wrapped in a sanitizer/validator/escaper), use OpenGrep **`mode: taint`**. Taint rules:

- track the value through assignments and aliases (no dependence on naming conventions)
- automatically respect sanitizer wrappers (no metavariable-regex hacks like `^(?!.*(sanitized|safe))`)
- produce dramatically less noise on real codebases (often by 100×) while preserving coverage of the original vulnerable line

Skeleton:

```yaml
rules:
  - id: my-detector
    languages: [typescript, javascript]
    severity: ERROR
    message: <one-sentence explanation, cite the GHSA / CVE>
    paths:
      include:
        - src/<the-area>/... # always scope; almost no taint rule should be repo-wide
    mode: taint
    pattern-sources:
      - patterns:
          - pattern-either:
              - pattern: $X.workspaceDir
              - pattern: someUntrustedAccessor(...)
    pattern-sanitizers:
      - patterns:
          - pattern-either:
              - pattern: sanitizeFoo(...)
              - pattern: validateFoo(...)
    pattern-sinks:
      - patterns:
          - pattern-either:
              - pattern: |
                  `...${$VALUE}...`
              - pattern: fetch($VALUE, ...)
              - pattern: exec($VALUE, ...)
```

Reach for syntactic `patterns:` (no `mode: taint`) only when:

- the bug is a single AST shape with no dataflow (e.g. "this exact API is called with literal `false` for the auth flag")
- there is no meaningful sanitizer/validator (just "you must call helper X explicitly")
- the dangerous shape is the _absence_ of a check rather than data flowing somewhere

Reach for CodeQL (`B`) only when intra-file taint is not enough — typically because the dataflow crosses files, requires sophisticated barrier reasoning, or needs type-aware analysis OpenGrep can't do.

If you choose taint mode, say so in the report under `## Justification`, and explain what the source / sanitizer / sink list represents.

Good artifact names:

- `opengrep/general-rule.yml`
- `opengrep/broad-rule.yml`
- `opengrep/tests/positive/*.ts`
- `opengrep/tests/negative/*.ts`
- `codeql/queries/<slug>.ql`
- `codeql/fixtures/positive/*.js`
- `codeql/fixtures/negative/*.js`

## Step 5: Validate Every Produced Artifact

Do not call a detector successful unless it was executed.

Validation floor:

- General OpenGrep rule:
  - must hit the vulnerable positive
  - must hit at least one non-identical same-family positive
  - must miss at least one close negative control
  - should be run against the repo to check for nearby variants
- CodeQL query:
  - must hit a positive fixture or known vulnerable code path
  - must miss a safe control
  - should be run against the repo or a targeted database if one exists
- Broad OpenGrep rule:
  - must hit the positive
  - may be noisy on repo scan
  - must still produce findings that can be bucketed into `interesting` or `noise`

Reject weak artifacts:

- catches only the exact known snippet and nothing else
- catches only the advisory shape and a trivial variable-rename clone
- matches almost every callsite with no meaningful narrowing
- cannot be explained in one sentence

If tooling is missing or too expensive to run, do not fake confidence. Mark the artifact `written, not executed`.

## Step 5.5: Coverage-First Validation (mandatory before shipping `A`)

Fixture tests are necessary but **not sufficient** to ship. The single most important question for any `A=yes` decision is:

> Does this rule, run against the _vulnerable commit's_ version of the fix-changed files, produce at least one finding?

If no, the rule is not catching the original vulnerability — regardless of how clean it looks on synthetic fixtures. **Do not ship a precise rule that fails this test.**

### How to run coverage validation

```bash
FIX=<fix-commit>
VULN=<vulnerable-commit>     # usually $FIX^

TMPDIR=$(mktemp -d)
git diff-tree --no-commit-id --name-only -r "$FIX" \
  | grep -vE '\.(md|json|lock)$|^CHANGELOG' \
  | while read f; do
      mkdir -p "$TMPDIR/$(dirname "$f")"
      git show "$VULN:$f" > "$TMPDIR/$f" 2>/dev/null
    done

opengrep scan --config opengrep/general-rule.yml --json --no-git-ignore "$TMPDIR" \
  | python3 -c "import json,sys; print(len(json.load(sys.stdin).get('results',[])))"
```

### Coverage rubric

Run the rule on both sides of the patch:

- **Vulnerable commit changed files**: must produce `>= 1` finding for `A=yes`, unless the report explicitly documents an additive-fix exception.
- **Fixed commit changed files**: should produce `0` findings for exact regression canaries and scoped behavioral rules. If it still fires, classify every fixed-side finding as one of: `real residual bug`, `known false positive`, `review-aid noise`, or `expected variant surface`.
- **HEAD/repo scan**: use this to find verified variants and false positives. Do not optimize to zero findings; optimize to high-confidence real findings.

Decision outcomes:

- **Variant detector**: catches the OG vuln, is silent on the fixed pattern, and finds real same-family variants. This is the best `A=yes` outcome.
- **Regression detector/canary**: catches the OG vuln and is silent on the fixed pattern, but is too narrow to find new variants. This is acceptable when a generic detector is not feasible; label it clearly as a regression canary.
- **No precise rule (`A=no`)**: choose this when the pattern is not expressible with high confidence, fixed-side findings are only noise, or the correct detector is CodeQL/test/runtime-only.

### Special cases

- **Additive fixes** ("the fix adds a new check, allowlist entry, or validator call"): the vulnerable code may not contain _any_ of the symbols your rule keys on. In this case, document this explicitly under "Coverage validation" with the form: `Rule unmatchable on vuln commit because fix is additive (added <SYMBOL> to <FILE>); validated via synthetic positive fixtures only`. This is an acceptable `A=yes` outcome.
- **File renames for parser support**: if you need to rename files (e.g. extensionless shell scripts → `.sh`) so semgrep parses them correctly, record the renames in the report under `Coverage validation: extracted-as:` so external validators can apply the same renames.
- **Wrong vuln commit**: if the agent picked a non-parent ancestor (e.g. an earlier commit before some refactor), the changed-file extraction won't make sense. Recheck Step 1 — the vulnerable commit should be the **immediate parent** of the fix unless you have an explicit reason to use an earlier point.

### Required report section

Every report must contain a `## Coverage validation` section with:

```
- Fix commit: <SHA>
- Vulnerable commit: <SHA or SHA^>
- Files changed by fix: <N>
- Findings on vuln-commit changed files: <K>     # MUST be >= 1 if A=yes, unless additive-fix exception
- Findings on fixed-commit changed files: <F>    # SHOULD be 0 for regression canaries; classify if non-zero
- Findings on patched repo/HEAD: <M>
- Decision: A=<yes|no>
- Justification: <one sentence>
- Extracted-as: <optional file-rename map>
```

### Precision and variant triage

Coverage is mandatory, but production rules must still be high-confidence. Specific anti-patterns to avoid:

- **Don't** keep a rule broad merely because it catches the OG vuln. Tighten it until repo findings are explainable as real variants, exact regressions, or explicitly accepted review-aid hits.
- **Don't** reject a rule that catches the OG vuln just because it finds additional callsites. Open each finding and classify it; extra findings are valuable only when they are real same-family variants.
- **Do** reject or downgrade when matches are unrelated (e.g. substring regex matching `iss.path` because of `path`) or when fixed-commit findings are only safe code.

If a rule is noisy but has real coverage, first try the preference ladder: taint mode → scoped behavioral rule → exact regression canary → `A=no`. Prefer `paths.include`, identifier anchors, and sanitizer-aware taint rules over wide metavariable-regex heuristics.

## Final Report

Read `security/detector-review/references/report-template.md` and fill it in.

The report should answer:

- what the vulnerable code was
- why the bug happened
- which of `A`, `B`, `C` were worth producing
- how each artifact performed on positives, negatives, and repo scan
- whether the advisory class looks promising for future regression hunting

## Guardrails

- **Coverage is mandatory; precision is the goal.** A rule that misses the OG vuln must not ship, but a rule that catches the OG vuln and floods CI with unrelated findings also must be tightened, downgraded, or rejected.
- Prefer real variants over theoretical breadth. Start as wide as reasonable, then reduce to findings you can defend as real regressions or verified same-family variants.
- Exact regression canaries are acceptable when generic variant detection is not feasible. Label them as regression canaries; do not pretend they are family-level detectors.
- Do not silently downgrade a failed `A` into an unvalidated exact-match rule. If it cannot catch the vulnerable commit and is not an additive-fix exception, say `A` is not appropriate.
- **Don't reach for `A: no` too eagerly**, but do use it when the only possible OpenGrep rule would be noisy, misleading, or unable to distinguish fixed functionality from vulnerable behavior.
- Keep repo scans separate from fixture validation. Fixtures prove shape; repo scans prove signal.
- When broad OpenGrep is the only viable static option, say that it is a review aid, not an auto-triage detector.
- If CodeQL would help but the query would just restate a built-in query with no useful specialization, say so.
- **Don't trust your own fixtures.** Synthetic fixtures are written by the same model that wrote the rule, so they're prone to confirmation bias. The Step 5.5 coverage validation against the actual vulnerable commit is the only objective signal.
