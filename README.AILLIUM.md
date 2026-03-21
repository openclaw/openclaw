# aillium-openclaw

## Purpose

`aillium-openclaw` is a **fork of OpenClaw** used by Aillium as runtime and orchestration infrastructure.

Aillium-specific control-plane behavior should be integrated through thin adapters, not deep runtime forks.

## What This Repo Does

- Reuses upstream OpenClaw runtime/orchestration capabilities
- Hosts thin Aillium integration boundaries for external contracts and callbacks
- Provides a stable bridge to Aillium Core and external execution surfaces

## What This Repo Does NOT Do

- No tenancy ownership or policy authority
- No approval decision ownership
- No replacement of Aillium Core as source of truth

## Architecture role

Runtime and orchestration substrate, with Aillium Core as the enterprise control plane.

## Integration boundaries

See `src/aillium/`, `docs/aillium-sync-plan.md`, and `docs/aillium-module-inventory.md` for adapter boundaries and sync inventory:

- contract adapters
- evidence callback hooks
- tenant/session metadata passthrough
- runtime registration with Aillium Core

## Upstream notice

This repository is a fork of OpenClaw.
Original license and notices are preserved.

## Upstream origin

Original source: https://github.com/openclaw/openclaw
