# Durable Workflow Core Prototype

Status: prototype slice, disabled by default.

## Goal

OpenClaw needs a small native durable control plane for agent turns before it can
reliably support long-running, multi-step, and multi-agent work. The first slice
does not try to replace Temporal, Restate, Hatchet, or LangGraph. It records
workflow identity, agent-turn lifecycle events, and restart recovery state so the
gateway can explain where a request went instead of silently losing in-flight
work.

## Current Slice

The prototype is enabled with `OPENCLAW_DURABLE_WORKFLOWS=1`.

- SQLite-backed store at `${OPENCLAW_STATE_DIR}/durable/workflows.sqlite`.
- Tables:
  - `durable_workflow_runs`
  - `durable_workflow_events`
- Gateway startup run: `openclaw.gateway.startup`.
- Agent turn run: `openclaw.agent.turn`.
- Gateway-local recovery worker:
  - `OPENCLAW_DURABLE_RECOVERY_INTERVAL_MS`, default `60000`
  - `OPENCLAW_DURABLE_STALE_AGENT_TURN_AFTER_MS`, default `21600000`
- Agent turn events:
  - `agent.turn.received`
  - `agent.turn.running`
  - `agent.turn.succeeded`
  - `agent.turn.failed`
  - `agent.turn.cancelled`
  - `agent.turn.lost`

Agent turn metadata stores routing and audit fields such as agent id, session
key, channel, transport, message length, and message hash. It intentionally does
not store the raw user prompt body.

## Gateway Placement

The durable lifecycle is recorded server-side in the gateway agent handler, not
in the CLI client. This keeps Discord, webchat, CLI, API, and future channel
frontdoors on the same source of truth.

The lifecycle boundary is:

1. Record `received` after session/channel resolution.
2. Record `running` when the run is accepted and registered.
3. Record terminal state from the actual agent runner callback.
4. On gateway startup, reconcile stale non-terminal agent turns from previous
   gateway lifecycles to `lost`.
5. While the gateway is running, periodically reconcile very old `received` or
   `running` agent turns to `lost`.

## Restart Semantics

This slice does not resume an in-flight model/tool call after process death. It
does make the failure explicit:

- A run accepted by the old gateway is recorded before dispatch.
- If the gateway restarts before terminal completion, startup reconciliation
  appends `agent.turn.lost`.
- If an agent turn remains `received` or `running` past the stale threshold,
  the local recovery worker appends `agent.turn.lost`.
- `waiting` runs are not marked lost by this worker so future human-in-the-loop
  gates can survive restarts and long pauses.
- The user or a future reconciler can retry from the stored idempotency key,
  input reference, session key, and event timeline.

## Validation

Manual validation against OpenClaw A:

- Short agent message: `succeeded`, three events.
- Longer multi-step prompt: `succeeded`, three events.
- Parallel branches: one branch `succeeded` while another timed out as
  `cancelled`; states did not mix.
- Gateway restart during an in-flight run: old gateway run became `lost` with
  `agent.turn.lost`; a new post-restart message succeeded.
- Recovery worker smoke after restart: new agent turn succeeded while the worker
  was active.

Automated checks run:

- `npm test -- --run src/durable src/gateway/server-methods/agent.test.ts`
- `npm test -- --run src/durable src/cli/program/register.agent.test.ts src/commands/agent-via-gateway.test.ts`
- `npm run tsgo:core`
- `npm run build`

## Proposed PR Stack

1. Durable store foundations:
   - shared durable workflow types
   - SQLite store
   - feature flag and state-dir path resolution
   - store tests

2. Gateway lifecycle hook:
   - record gateway startup
   - add startup reconciliation for stale open agent turns
   - start/stop a gateway-local stale-run recovery worker
   - keep recovery best-effort and non-blocking for user traffic

3. Agent turn lifecycle:
   - server-side gateway agent turn recording
   - received/running/terminal event timeline
   - prompt hash and metadata, not raw prompt storage

4. Follow-up recovery API:
   - query run timeline
   - retry/cancel by workflow run id
   - reconcile `lost` runs into explicit retry proposals

5. Follow-up multi-agent contract:
   - parent/child run links
   - fan-out/fan-in step ids
   - child failure isolation and parent continuation policy

## Anti-goals

- No deterministic replay runtime in this slice.
- No embedded Temporal/Restate/Hatchet/LangGraph implementation.
- No AICOS-specific concepts in OpenClaw core.
- No raw prompt persistence in the durable journal.
- No dashboard changes.
