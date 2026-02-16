# Control Plane Temporal Worker (skeleton)

This package owns the Temporal runtime bootstrap for dispatch control-plane workflows.

- `DISPATCH_TEMPORAL_MODE=temporal` starts a real Temporal worker (requires `@temporalio/worker`).
- default mode runs a skeleton heartbeat so the container can start in dev without Temporal SDK installed yet.
- package is intentionally read-only and does not publish mutating commands yet.

Environment:

- `DISPATCH_API_URL` (default: `http://dispatch-api:8080`)
- `TEMPORAL_ADDRESS` (default: `temporal:7233`)
- `TEMPORAL_NAMESPACE` (default: `default`)
- `TEMPORAL_TASK_QUEUE` (default: `dispatch-ticket-workflows`)
- `DISPATCH_TEMPORAL_HEARTBEAT_MS` (default: `5000`)
- `DISPATCH_TEMPORAL_SHUTDOWN_MS` (default: `10000`)
- `DISPATCH_TEMPORAL_WORKER_IDENTITY` (auto-generated if omitted)

## Local dev bootstrap

Run in shell (no Temporal dependency required):

```sh
DISPATCH_TEMPORAL_MODE=bootstrap node packages/control-plane-temporal/src/worker.mjs
```

## Temporal + hello workflow smoke path

When a Temporal dev server is available (`temporal` service on `:7233`):

```sh
DISPATCH_TEMPORAL_MODE=temporal node packages/control-plane-temporal/src/worker.mjs
```

Run a one-off hello/readback workflow against a ticket id:

```sh
temporal workflow start \
  --task-queue dispatch-ticket-workflows \
  --workflow-type ticketReadbackWorkflow \
  --workflow-id rd-smoke-readback-$(date +%s) \
  --input '{ "ticketId": "00000000-0000-4000-8000-000000000001" }'
```

The workflow calls `readTicket` and `readTimeline` activities only; it does not mutate state.

## docker-compose excerpt (dev)

```yaml
services:
  temporal:
    image: temporalio/auto-setup:1.22
    ports:
      - "7233:7233"

  control-plane-temporal:
    build:
      context: ../..
      dockerfile: Dockerfile
    command: ["node", "packages/control-plane-temporal/src/worker.mjs"]
    environment:
      DISPATCH_API_URL: "http://dispatch-api:8080"
      TEMPORAL_ADDRESS: temporal:7233
      DISPATCH_TEMPORAL_MODE: "temporal"
      DISPATCH_TEMPORAL_HEARTBEAT_MS: "5000"
    depends_on:
      - temporal
    restart: unless-stopped
```

Use `DISPATCH_TEMPORAL_MODE=bootstrap` in this compose when you only need the read-only heartbeat in dev.
