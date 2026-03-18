# operator-node

Operator Node is a governed computer-use scaffold for GODSClaw.

## Purpose

This extension provides the foundation for:

- desktop and browser observation
- structured action planning
- policy and approval gating
- bounded execution
- verification and recovery
- audit logging

## Current status

This is a scaffold, not a fully wired runtime plugin.

Implemented in this first pass:

- strongly typed operator contracts
- perception normalization interfaces
- planner skeleton
- policy engine
- executor abstraction with dry-run support
- verifier logic
- audit event model
- orchestration class for end-to-end flow

## Initial operating modes

- `read-only`
- `suggest-only`
- `approval-required`
- `bounded-autonomy`

## Design notes

- Keep operator actions attributable to session and workspace.
- Prefer dry-run and approval paths by default.
- Treat desktop automation as high-trust capability.
- Keep browser and desktop execution behind one policy model.

## Next wiring steps

1. bind screenshot capture into perception adapters
2. bind browser actions into the existing browser tooling
3. bind node/device actions into node invocation pathways
4. surface approval requests through the gateway UI and chat surfaces
5. persist audit events through the gateway event/logging stack
