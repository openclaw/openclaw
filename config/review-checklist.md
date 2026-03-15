# Review Checklist

## Auth checks

- Is there a visible session or actor boundary before business logic runs?
- Are unauthenticated callers rejected before scoped data access?
- Are auth endpoints protected against brute force and abuse?

## Ownership checks

- Does the route bind access to the authenticated actor rather than caller-supplied ids?
- Are resource routes protected by ownership, participant, or membership checks?
- Can one user reach another user's records through a guessed id?

## RLS alignment

- Do database policies match the assumptions claimed by the API layer?
- Are permissive `USING (true)` or `WITH CHECK (true)` clauses avoided?
- Are reads and writes both protected by the intended policy contract?

## Admin boundaries

- Are admin or support routes explicitly guarded?
- Are admin operations attributable and auditable?
- Can support tooling escalate into unrestricted reads or writes?

## OTP abuse paths

- Is OTP issuance rate-limited?
- Is verification single-use and replay-resistant?
- Are delivery channels represented clearly without leaking account existence?

## Webhook trust

- Is signature verification enforced before processing?
- Are replay windows and duplicate deliveries handled safely?
- Is the raw payload boundary preserved when required by the provider?

## Input validation

- Is request input validated with an explicit schema?
- Are unknown or malformed fields rejected deterministically?
- Are unsafe URLs, HTML, and rich text constrained before use?

## Reflected / stored XSS

- Do render paths avoid unsafe HTML primitives?
- Is attacker-controlled content escaped or sanitized?
- Are review, profile, and message surfaces protected from injection?

## Sensitive data exposure

- Do responses avoid leaking secrets, tokens, cookies, or unnecessary identifiers?
- Do logs redact OTP, auth, and personal data?
- Are public error strings stable and safe?

## Logging / audit expectations

- Are privileged or risky mutations auditable?
- Are verification failures observable without secret leakage?
- Is there enough evidence to reproduce and test a remediation?
