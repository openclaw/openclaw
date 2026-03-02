# ADR: Channel Routing Model

**Date:** 2025-01-01 (reconstructed)

## Context

Messages arrive from many surfaces (Telegram, Discord, Signal, etc.) and need to be routed to the right session/agent. The routing logic must be consistent regardless of source channel.

## Decision

Routing lives in `src/routing/` as a shared layer. Individual channel monitors (`src/telegram`, `src/discord`, etc.) normalise inbound messages into a common format before handing off to the router. The router resolves the target session based on channel config, allowlists, and group vs DM context.

When refactoring routing, allowlists, pairing, command gating, onboarding, or docs — always consider all built-in + extension channels, not just the one being changed.

## Consequences

- Adding a new channel means implementing the normalisation layer; routing logic is inherited for free
- Bugs in routing affect all channels simultaneously — test broadly
- Channel-specific behaviour (e.g. thread-bound sessions on Discord) is handled in the channel layer before routing
