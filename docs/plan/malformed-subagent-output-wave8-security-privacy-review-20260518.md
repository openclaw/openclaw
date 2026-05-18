# Wave 8 security and privacy review

Date: 2026-05-18
Scope: raw child artifact retention, redaction, telemetry, docs, and release
readiness for the malformed subagent output hardening work.

## Verdict

No raw child bodies should be committed, logged to normal telemetry, rendered in
ordinary chat, preserved by compaction, exported to memory/session history, or
shown in dashboards. Raw payload access is restricted to explicit local
operator raw-open flows.

## Sensitive data assumptions

Malformed child output may contain:

- source code, patches, stack traces, long command logs, and path listings;
- tokens, credential-looking keys, private-key-like material, local paths, and
  user/task context;
- prompt-injection text asking the parent to trust or preserve the raw body.

All raw child output is treated as sensitive until scanned and retained only in
quarantine.

## Retention and deletion

- Default quarantine retention is bounded by TTL, max bytes, and max count.
- Cleanup is scheduled/startup eligible and supports explicit operator deletion
  by artifact id.
- Metadata records retain only opaque id, hashes, sizes, labels, timestamps,
  child/requester ids, redaction summary, and retention policy.
- Raw payloads are excluded from git, ordinary backups/sync, memory extraction,
  dashboards, and normal telemetry.
- Encryption-at-rest is not yet implemented; this remains an accepted
  threat-model exception only while the store is local, permission-restricted,
  and outside synced/git-backed locations.

## Redaction and metadata checks

- Telemetry records hashes, byte counts, counters, normalized state, labels,
  schema/verifier versions, and opaque ids only.
- Parser errors store failed-input hash and size, not parse input.
- Sanitized evidence metadata removes local artifact/log paths before parent or
  dashboard display.
- Operator-facing status cards expose copyable artifact id/hash, never raw body
  snippets or raw-derived filenames.
- Documentation and release records avoid embedding raw malformed payloads.

## Raw-open risk controls

Raw-open remains a local, explicit, audited operation:

1. No automatic preview.
2. No model-context injection.
3. No markdown/HTML/ANSI rendering.
4. No first-lines or snippet view.
5. No copy into ordinary chat/history/memory.
6. Metadata-only audit event with artifact id/hash.

## Rollback risk controls

Rollback cannot disable quarantine, compaction sanitation, or raw-output
exclusion. If acceptance enforcement is disabled, subagent-derived gates degrade
to `DIRECT_VERIFICATION_REQUIRED`; child chat `PASS` and schema-valid `PASS`
remain non-success.

## Final review outcome

Security/privacy review accepts release readiness if the final scan confirms:

- no raw quarantine payloads are tracked by git;
- no credentials or private keys were introduced;
- docs/test fixtures contain only synthetic safe sentinel text;
- no forbidden generated, package, config, credential, or external-message side
  effects occurred;
- rollback drill remains green.
