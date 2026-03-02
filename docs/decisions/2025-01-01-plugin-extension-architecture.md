# ADR: Plugin/Extension Architecture

**Date:** 2025-01-01 (reconstructed)

## Context

OpenClaw needed to support many messaging channels (Telegram, Discord, Slack, Signal, iMessage, WhatsApp, Teams, Matrix, etc.) without bloating the core package. Each channel has different dependencies, auth flows, and message formats.

## Decision

Channels and integrations live as workspace packages under `extensions/*`. Each extension has its own `package.json` and dependency tree. Core (`src/`) contains only the routing, session, and agent infrastructure. Extensions are loaded at runtime via the plugin system.

Key rules:

- Plugin-only deps stay in the extension `package.json`; never added to root unless core uses them
- Runtime deps must be in `dependencies` (not `devDependencies`) — `npm install --omit=dev` is run in plugin dirs
- `workspace:*` is forbidden in `dependencies` (npm install breaks); put `openclaw` in `devDependencies` or `peerDependencies`

## Consequences

- Core stays lean; channels can be installed independently
- Each extension can version independently
- Adding a new channel requires updating `extensions/*`, `.github/labeler.yml`, and all relevant UI surfaces (macOS app, web UI, mobile, onboarding docs)
