# Update capture failure diagnostics

Related: #169259

Status: draft plan only. No runtime behavior has changed. Replace this planning file with the reviewed implementation before marking the PR ready.

## Observed problem

The 2026.10.1-beta.2 updater targeting 2026.10.5-beta.1 left its original recovery capture unsealed and reported a combined generation-changed-or-unverifiable message. The update ultimately succeeded. Active-writer rejection is documented behavior; an incorrect rejection is not established.

## Implementation plan

1. Trace the installed-driver capture flow and existing backup generation diagnostics. Distinguish source generation missing, generation read failure, and a genuine later write. Do not infer the failing database from current live generations.
2. Carry bounded, redacted database-specific reasons from the backup owner through the existing capture exception and CLI warning. Preserve incomplete evidence, the no-seal guard, best-effort update continuation, and existing manual-recovery semantics.
3. If an unchanged-state false rejection can be reproduced, repair it at its producing owner; otherwise scope the change to diagnostics. Do not add an independent generation reader or weaken integrity checks.
4. Extend the existing capture regression at the real capture boundary to assert actionable reasons for changed and unavailable generations. Verify that genuine later writes still prevent manifest publication and preserve both live rows and retained evidence. Use synthetic isolated state.
5. Validate the installed published driver against the candidate through the supported CLI update flow. Run focused owner tests, the affected build lane for worker/package output, and fresh review. Record focused test wall time and remaining reproduction gaps in the PR.

## Acceptance

- The existing CLI warning identifies a safe database label and the concrete failure category without leaking database contents or credentials.
- Genuine changes and unverifiable generations remain unsealed; unfinished payloads survive for inspection.
- Update success/failure and rollback guarantees are unchanged.
- Evidence distinguishes tested behavior from the unproven cause of the reported production capture failure.

