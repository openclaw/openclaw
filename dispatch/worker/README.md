# Dispatch Worker Scaffold

Background jobs owned by worker:

- follow-up reminders
- schedule nudges/escalations
- stale ticket detection
- closeout packet assembly tasks
- invoice draft generation retries

Worker jobs must call dispatch-api and emit auditable outcomes.

Current demo/default operational mode:

- `dispatch-worker` starts `dispatch/worker/dispatch-worker-placeholder.mjs` in MVP container stacks.
- The placeholder emits periodic heartbeat logs and waits for SIGINT/SIGTERM.
- Replace with full background job orchestrator before enabling production workloads.
