# Coverage-First Validation (mandatory)

The single most important rule for this advisory:

**The OpenGrep general rule (`opengrep/general-rule.yml`) MUST find at least one match in the files changed by the fix commit, when run against the _vulnerable commit's_ version of those files.**

A rule that doesn't catch the original vulnerability is worthless, regardless of how clean its fixtures look or how few false positives it produces on the patched repo. Coverage of the OG vuln is the floor.

## Mandatory validation step (do this before deciding A=yes/no)

After producing the rule and running fixture tests, execute the validation in Step 5.5 of the skill:

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
  | python3 -c "import json,sys; print('Findings:', len(json.load(sys.stdin).get('results',[])))"
```

## Coverage rubric

- **0 findings on vuln-changed files** → the rule does NOT catch the OG vuln. **DO NOT ship this rule** as-is. Either:
  - rewrite it to match the actual vulnerable pattern from the fix diff, OR
  - if the fix is purely additive (adds new symbols/keys/checks that did not exist pre-fix), explicitly include the literal phrase `Rule unmatchable on vuln commit because fix is additive` in the report's Coverage validation section, OR
  - honestly choose `A: no` with technical reasoning.
- **>=1 finding on vuln-changed files** → coverage achieved. Ship it (`A: yes`) **even if the broader repo scan produces many findings**. A rule with 50, 100, even 500 findings on the patched repo is still useful if it catches the OG vuln, because:
  - The findings are likely the same call-sites that needed patching (real review surface).
  - It can be scoped via `paths.include` if needed, but coverage matters more than noise.

## Noise is secondary

Common anti-patterns to avoid:

- **Don't** reject a rule because "it might match safe normalized flows" if it actually finds the vulnerable code. Real call-sites of the same API are NOT noise — they're useful review surface.
- **Don't** reject a rule because "the broader repo has many matches" if the matches are all in code that needs the same review.
- **Don't** rewrite a working rule to be "tighter" if tightening it causes coverage to drop to 0.
- **Only reject `A: no`** if the rule fundamentally cannot match the vulnerable pattern, OR if it matches truly unrelated code (e.g. matching `iss.path` because of a substring regex), OR if the bug class genuinely needs a non-static-analysis approach.

## File-rename hint

If you need to rename a file for parser support (e.g. extensionless shell scripts → `.sh`), record the renames in the report under `Coverage validation: extracted-as:` so external validators can apply the same renames:

```
- Extracted-as:
  - git-hooks/pre-commit -> git-hooks/pre-commit.sh
  - Makefile -> Makefile.mk
```

## Required report section

Every report must contain a `## Coverage validation` section with this exact shape:

```
## Coverage validation
- Fix commit: <SHA>
- Vulnerable commit: <SHA or SHA^>
- Files changed by fix: <count>
- Findings on vuln-commit changed files: <N>  (must be >=1 if A=yes, unless additive-fix annotated)
- Findings on patched openclaw/src/: <M>
- Decision: A=<yes|no>
- Justification: <one sentence>
- Extracted-as: <optional file-rename map>
```

If your rule does not satisfy the coverage requirement (0 findings on vuln-changed files) and the fix is not additive, be explicit in the report: "Rule does not satisfy coverage requirement; choosing A: no" — and explain what makes the vuln pattern hard to express.

## Prefer OpenGrep `mode: taint` over syntactic patterns

Before writing rule `A`, ask: **"Can I describe this bug as 'untrusted X reaches dangerous Y unless it goes through helper Z'?"**

If yes, use `mode: taint`. Taint rules:

- Track the value through assignments and aliases — no dependence on naming conventions like `sanitized*` or `display*`
- Respect sanitizers automatically — no `metavariable-regex` hacks like `^(?!.*(sanitized|safe))`
- Produce ~100× less noise on real codebases while preserving coverage of the original vulnerable line

Skeleton:

```yaml
rules:
  - id: my-detector
    languages: [typescript, javascript]
    severity: ERROR
    message: <one-sentence explanation, cite the GHSA / CVE>
    paths:
      include:
        - src/<the-area>/...
    mode: taint
    pattern-sources:
      - patterns:
          - pattern-either:
              - pattern: $X.untrustedField
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

Use a syntactic `patterns:` rule (no `mode: taint`) only when:

- The bug is a single AST shape with no dataflow (e.g. an exact API called with literal `false` for an auth flag)
- There is no meaningful sanitizer to consult (the rule is "you must call helper X explicitly")
- The dangerous shape is the _absence_ of a check rather than data flowing somewhere

If a syntactic version of your rule produces >100 findings on the patched repo, that's a strong signal you should reach for taint mode instead — even if the syntactic version technically catches the OG vuln.

Always note your choice in the report under `## Justification`: "taint mode (sources: …, sanitizers: …, sinks: …)" or "syntactic (no dataflow)".
