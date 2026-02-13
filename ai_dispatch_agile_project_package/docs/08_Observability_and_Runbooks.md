# Observability + Runbooks (SRE Reality)

## 1) What must be observable (v0)
If you cannot answer these quickly, dispatch will collapse:
- Why did ticket X change state?
- Who/what initiated it (agent/tool/human)?
- What evidence was attached?
- Are we breaching SLAs right now?
- Are tool calls failing or stuck?

## 2) Logging (structured)
Required log fields for every request:
- request_id (idempotency key)
- correlation_id
- trace_id/span_id (if available)
- actor_type/actor_id/role
- tool_name
- ticket_id
- endpoint + status code + latency

## 3) Metrics
### Service health
- `dispatch_api_requests_total{route,code}`
- `dispatch_api_latency_ms_bucket{route}`
- `dispatch_api_errors_total{type}`

### Dispatch ops KPIs (near-real-time)
- `tickets_created_total`
- `state_transitions_total{from,to}`
- `tickets_in_state{state}` (gauge)
- `sla_breach_total{priority}`
- `idempotency_replay_total`
- `idempotency_conflict_total`

### Tool bridge
- `tool_invocations_total{tool,code}`
- `tool_latency_ms_bucket{tool}`

## 4) Tracing
Use OpenTelemetry:
- gateway → agent → tool bridge → dispatch-api → db
- propagate correlation_id and trace headers

## 5) Runbooks (v0)
### RB1: Scheduling stuck (READY_TO_SCHEDULE for too long)
1) Check queue view for SLA timer and missing fields
2) Inspect timeline for last mutation and actor
3) Confirm customer contact reachable; send follow-up
4) If emergency, bypass to direct dispatch with reason logged

### RB2: Completion rejected
1) Identify which evidence requirement failed (incident template)
2) Ask tech to upload missing photo/signature
3) Re-run `tech.complete` with same ticket and new request_id

### RB3: Idempotency conflicts spiking
1) Check clients reusing request_id with different payload
2) Ensure tool bridge generates a UUID per attempt
3) Add client-side dedupe and retry policy

### RB4: SLA breach
1) Identify if delay is customer-caused vs provider-caused
2) Escalate to on-call dispatcher
3) Record mitigation (temporary secure, alternate entry, etc.)

