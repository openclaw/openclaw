# Backup Scope Browser and Session Denylist

Backup scope must exclude browser/session artifacts that can leak credentials, auth state, or cross-project context.

Do not back up these classes without a separate approved, redacted, security-reviewed export process:

- browser cache
- browser cookies
- local storage
- session storage
- auth tokens
- wallet state
- SSH private keys
- credential vault exports
- profile lock files
- temporary download folders containing authenticated exports

Rules:

- Treat denylisted artifacts as credential-boundary material.
- Redact sensitive paths and values in reports.
- If backup scope ambiguity exists, mark evidence_status as Unknown and escalate to Control Director.
- If denylisted material is detected, stop and require rollback_or_cleanup_plan before any further backup work.
