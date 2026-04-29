# Security Finding Remediation — Specification

Use this workflow when turning a validated detector finding into a code fix.

Goal: block the exploit while preserving intended product behaviour. If the secure
fix changes or removes supported behaviour, say so explicitly and present options
instead of silently breaking users.

## Inputs

- Finding source: OpenGrep / CodeQL / manual review
- Advisory or detector ID, if applicable
- Finding file + line
- Original vulnerability explanation
- Existing tests around the affected feature

## Step 1: Prove the Finding

Before editing code, write down:

1. **Source**: attacker-controlled or lower-trust value
2. **Sink**: security-sensitive operation
3. **Missing guard**: what check/sanitizer/policy should sit between them
4. **Exploit sketch**: a minimal realistic bad input
5. **Expected safe behaviour**: what valid user flow must keep working

If you cannot identify all five, stop and ask for triage; do not make a speculative fix.

## Step 2: Choose the Narrowest Safe Fix

Prefer fixes in this order:

1. Reuse the canonical helper already used elsewhere in the codebase.
2. Move the invariant into a shared boundary API so future callsites are safe by construction.
3. Add a small local guard only when there is no reusable helper.
4. Reject the operation with a clear error if the safe behaviour cannot be supported.

Do not create a second ad-hoc policy list when a canonical policy already exists.

## Step 3: Check Functionality Tradeoffs

For every proposed fix, answer:

- What valid workflow could this break?
- Is there an existing config option or compatibility mode that relies on the old behaviour?
- Can we preserve functionality by adding an explicit opt-in, migration, or narrower allowlist?
- Is the old behaviour itself the security bug?

If the secure fix changes behaviour, include a section in the PR description:

```markdown
## Security / functionality tradeoff

This fix blocks <exploit>. It may affect <valid workflow> because <reason>.
Options considered:

1. <chosen option> — <why>
2. <alternative> — <why not>
```

If there is no safe non-breaking fix, say:

> This cannot be fully fixed without changing product behaviour. I recommend
>
> <option>, but maintainers should choose between security and compatibility.

## Step 4: Tests Required

Every remediation should add or update tests for both sides:

- **Exploit-blocking test**: the bad input is rejected, sanitized, or routed through the safe helper.
- **Functionality-preserving test**: a valid input still succeeds.
- **Regression detector test** when applicable: the OpenGrep/CodeQL rule no longer flags the fixed code but still flags a vulnerable fixture or commit.

If no automated test is feasible, document why and include a manual validation command.

## Step 5: Validate the Detector After the Fix

If the fix was driven by an OpenGrep or CodeQL rule:

1. Run the detector on the vulnerable fixture/commit and confirm it still fires.
2. Run the detector on the fixed tree and confirm either:
   - it no longer fires, or
   - any remaining findings are real residual bugs / known false positives documented in the PR.
3. Run relevant unit/integration tests for the affected feature.

## Step 6: PR Summary Template

```markdown
## Summary

Fixes <finding/advisory> by <one-sentence fix>.

## Security impact

- Source: <source>
- Sink: <sink>
- Guard added/reused: <guard>
- Exploit blocked: <brief sketch>

## Functionality impact

- Expected valid workflow preserved: <yes/no>
- Behaviour change: <none / description>
- Compatibility tradeoff: <none / options>

## Validation

- [ ] Exploit-blocking test
- [ ] Functionality-preserving test
- [ ] Detector still catches vulnerable fixture/commit
- [ ] Detector is clean on fixed code or remaining findings documented
- [ ] Relevant test command(s): `<command>`
```

## Red Flags

Stop and ask for maintainer input if:

- The only safe fix disables a documented feature.
- The fix changes defaults, config schema, persisted state, or migration behaviour.
- The detector finding is in compatibility code or a user-controlled escape hatch.
- The remediation requires choosing between security and product semantics.
