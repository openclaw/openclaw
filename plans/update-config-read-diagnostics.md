# Candidate config reader failure diagnostics

Related: #169261

Status: draft plan only. No runtime behavior has changed. Replace this planning file with the reviewed implementation before marking the PR ready.

## Observed problem

A beta update passed canary config and startup checks but later emitted candidate-config-read-failed with no underlying reason. It preserved the existing service definition and eventually succeeded. ClawSweeper identifies diagnostic loss in the generated compatibility reader; the warning severity was repaired separately in #165539.

## Implementation plan

1. Personally inspect the current scripts/lib/update-config-runtime-compat.mts owner and runtime-postbuild generation. Trace failed child results, child error/exit/timeout, and stderr handling through the shipped io.runtime.js alias. Canary config success does not guarantee this later read succeeds.
2. Preserve a bounded, sanitized failure category through the existing compatibility reader and updater warning. Reuse the current redaction and warning contract. Keep optional fallback, unchanged service definitions, and best-effort updating.
3. Extend the existing generated-alias package-swap fixture to require an actionable reason for a missing candidate dependency. Cover relevant child failure/timeout handling without exposing config, secrets, raw stacks, or unrelated stderr.
4. Build generated output through its owner, never edit dist by hand. Run the focused alias-boundary test and affected build/type lanes; record test wall time and obtain fresh review.
5. Prove the published-driver × candidate update cell with an isolated service/config fixture. Record whether the reported Debian trigger is reproduced; do not claim its unknown cause has been fixed merely by improving diagnostics.

## Acceptance

- The real generated alias reports a safe, specific failure category.
- Service preparation still falls back safely when an optional read fails.
- Existing canary admission and service ownership checks remain unchanged.
- No duplicate severity repair, forced restart, dependency bump, or breaking contract is included.

