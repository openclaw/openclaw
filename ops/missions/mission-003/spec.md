# Mission 003 — Autonomous Deliverable Test

Goal:
Prove Voltaris + Strike Team Alpha can complete a real repo change autonomously and pass the gate system.

Success Criteria:

1. Alpha team executes a deliverable touching repo code.
2. alpha_smoke PASS.
3. gate_archive PASS.
4. Ledger receipt generated.
5. All outputs structured (no jq-breaking JSON).

## Deliverable 001 — Alpha Smoke Hardening

Task:
Harden the reviewer retry path in `ops/scripts/alpha_smoke.sh`.

Goal:
Ensure the retry logic:

- uses a timeout
- always emits JSON
- never causes jq parsing failures.

Success Criteria:

- Alpha smoke PASS 5/5
- Gate archive PASS
- Ledger receipt written
