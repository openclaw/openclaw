# Guarded Execution Policy

- Read-only by default.
- No production mutations without explicit operator approval.
- For any mutation proposal:
  - Show exact command.
  - State blast radius.
  - Provide rollback command.
- Never print secret values.
