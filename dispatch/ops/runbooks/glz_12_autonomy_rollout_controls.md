# GLZ-12 Autonomy Rollout Controls

Legacy ID retained for history; see `99-Appendix/legacy-id-mapping.md` for the current E/F/S mapping.

## Purpose

Runbook for operator controls used when an automation rollout needs to be paused, constrained, or rolled back.

## Roles and gates

- Command access: dispatcher role only (`ops.autonomy.*` policies).
- State transitions are rejected on role or scope failure.
- Every pause/rollback command writes:
  - one row in `autonomy_control_state`
  - one row in `autonomy_control_history`
  - one immutable audit event in `audit_events` with `ticket_id = null`

## Control commands

### 1) Pause by global scope

```bash
curl -X POST http://127.0.0.1:8080/ops/autonomy/pause \
  -H 'content-type: application/json' \
  -H 'Idempotency-Key: 12000000-0000-4000-8000-000000000001' \
  -H 'X-Actor-Id: dispatcher-ops' \
  -H 'X-Actor-Role: dispatcher' \
  -H 'X-Tool-Name: ops.autonomy.pause' \
  -d '{"scope_type":"GLOBAL","reason":"Operator initiated full rollback standby"}'
```

### 2) Pause by incident

```bash
curl -X POST http://127.0.0.1:8080/ops/autonomy/pause \
  -H 'content-type: application/json' \
  -H 'Idempotency-Key: 12000000-0000-4000-8000-000000000002' \
  -H 'X-Actor-Id: dispatcher-ops' \
  -H 'X-Actor-Role: dispatcher' \
  -H 'X-Tool-Name: ops.autonomy.pause' \
  -d '{"scope_type":"INCIDENT","incident_type":"DOOR_WONT_LATCH","reason":"Incident class surge handling"}'
```

### 3) Pause by ticket

```bash
curl -X POST http://127.0.0.1:8080/ops/autonomy/pause \
  -H 'content-type: application/json' \
  -H 'Idempotency-Key: 12000000-0000-4000-8000-000000000003' \
  -H 'X-Actor-Id: dispatcher-ops' \
  -H 'X-Actor-Role: dispatcher' \
  -H 'X-Tool-Name: ops.autonomy.pause' \
  -d '{"scope_type":"TICKET","ticket_id":"00000000-0000-0000-0000-000000000181","reason":"Customer-requested hard hold"}'
```

### 4) Rollback scope to manual mode

```bash
curl -X POST http://127.0.0.1:8080/ops/autonomy/rollback \
  -H 'content-type: application/json' \
  -H 'Idempotency-Key: 12000000-0000-4000-8000-000000000004' \
  -H 'X-Actor-Id: dispatcher-ops' \
  -H 'X-Actor-Role: dispatcher' \
  -H 'X-Tool-Name: ops.autonomy.rollback' \
  -d '{"scope_type":"GLOBAL"}'
```

## Readbacks and audit/replay checks

### Control-state read

```bash
curl http://127.0.0.1:8080/ops/autonomy/state?ticket_id=<ticket_id>
curl http://127.0.0.1:8080/ops/autonomy/replay/<ticket_id>
```

Validate that:

- `decision.scope_type` reflects highest-precedence scope (ticket > incident > global).
- `chain` includes all scopes affecting this ticket/incident.
- `history` returns immutable append-only replay rows for the query context.

## Rollback drill (pilot requirement)

1. Capture baseline:
   - `GET /ops/autonomy/state` for target account/site context.
2. Apply deterministic pause:
   - Run a scoped `POST /ops/autonomy/pause`.
3. Verify block on technician closeout:
   - `POST /tickets/{ticketId}/tech/complete` or `/tickets/{ticketId}/closeout/candidate` returns `AUTONOMY_DISABLED`.
4. Execute rollback:
   - `POST /ops/autonomy/rollback` for same scope.
5. Verify remediation:
   - `GET /ops/autonomy/state` now reflects manual mode (`is_paused = false`).
   - Technician closeout command resumes normal path.
6. Capture evidence for handoff:
   - `autonomy_control_state`
   - `autonomy_control_history`
   - `audit_events`

## Replacement criteria / shim removal

- If temporary operator tooling is used before production credentials are available, replace this runbook with a signed SRE dashboard action path.
- Target replacement date: before release candidate freeze and before GLZ-12 evidence packet close.
