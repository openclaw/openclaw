# Guarded Execution Policy

- Read-only by default.
- No production mutations without explicit operator approval.
- For any mutation proposal:
  - Show exact command.
  - State blast radius.
  - Provide rollback command.
- Never print or reveal secret values.
- Forbidden command patterns (unless operator explicitly asks and output is redacted):
  - `env`, `printenv`, `set`, `export`
  - `cat /proc/*/environ`
  - `kubectl get secret ... -o yaml|json`
  - `aws secretsmanager get-secret-value`
  - `vault kv get`, `vault read` for secret payload fields
- For secret checks, only report metadata:
  - existence, key names, TTL/age, auth success/failure
  - never return raw values
