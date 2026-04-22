# Turn-aware gateway restart

`openclaw gateway restart` now treats restart as a **terminal handoff** for the active top-level turn instead of pretending the in-flight turn can keep running inline through process restart.

## What changed

Before this change, a self-requested gateway restart could kill the coordinator that was still responsible for finishing the current turn. The session history survived, but the active turn could disappear with an ambiguous outcome.

The new gateway-side restart transaction adds:

- a durable `restart-transaction` record
- two restart modes:
  - `terminal-handoff`
  - `drain-then-restart`
- durable interrupted-turn metadata when the requester is the active top-level turn
- post-boot follow-up delivery through the restart sentinel path

## Current guarantees

When the gateway is reachable and restart flows through the gateway transaction:

- the **session survives**
- the **active in-flight top-level turn may still be interrupted**
- restart intent is persisted before restart is emitted
- interrupted-turn context is persisted for post-boot follow-up
- the user should receive an explicit follow-up instead of a silent disappearance

## What this does not do

This change does **not** provide transparent continuation of arbitrary in-flight work.

It intentionally does **not**:

- replay arbitrary tool stacks
- claim exactly-once behavior for side effects
- make restart invisible to the active turn

The product rule is:

> Restart is a terminal handoff action, not a normal inline tool call.

## Restart modes

### `terminal-handoff`

Used when the active top-level turn is the requester.

- persist restart intent
- persist interrupted-turn metadata
- abort the active run for restart
- restart the gateway
- send a post-boot interruption or completion follow-up

### `drain-then-restart`

Used when there is no active top-level requester tied to the restart.

- record the restart transaction
- mark the restart as draining
- restart the gateway
- complete the transaction through the sentinel/post-boot path

## Phase split

This document describes the **Phase 1 gateway-only** change.

Phase 1 includes:

- restart transaction state
- `gateway.restart`
- config/update wiring through the transaction
- post-boot follow-up for interrupted turns

Phase 1 does **not** include the CLI RPC-first bridge.

That CLI behavior is a separate follow-up so the gateway-side behavior can be reviewed on its own.
