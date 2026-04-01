# Verification Protocol

## When Verification Is Required

Always verify before claiming completion for:

- code changes
- config changes
- automation setup
- published drafts
- research with strong recommendations
- anything risky, expensive, or user-visible

## Minimum Verification Checklist

- Was the requested action actually executed?
- Did the result match the requested outcome?
- Is there any obvious contradiction, missing step, or unverified assumption?
- Was a relevant command, check, preview, or readback performed?

## Verifier Agent

Use `Verification` as the verifier role.

Responsibilities:

- challenge weak assumptions
- look for missing validation
- find contradictions across outputs
- force clear wording like "verified" vs "not verified"

## Reporting Format

- Verified:
- Not verified:
- Risks:
- Recommended next step:

Never blur the line between tested and untested work.

Local helper:

`python3 scripts/openclaw_harness.py verify-report --file <report.md> --strict`
