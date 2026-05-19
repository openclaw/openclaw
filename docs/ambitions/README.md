# Ambitions — Design Documents

This directory contains design documents and specifications for the Ambitions project — agent tooling, patterns, and architecture that extend beyond the OpenClaw codebase itself.

These are living documents. They inform our fork's direction but aren't part of OpenClaw's upstream.

## Documents

| Document                                       | Description                                                                                            | Status                               |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------ |
| [DIAGNOSTICS-SPEC.md](DIAGNOSTICS-SPEC.md)     | Structured diagnostics specification — stable codes, repair IDs, fix safety taxonomy for agent tooling | DRAFT — implementing in comms system |
| [ZERO-ADOPTION-PLAN.md](ZERO-ADOPTION-PLAN.md) | Two-track adoption plan for Zero language patterns (apply now, watch for Pi Core)                      | ACTIVE — Track 1 in progress         |
| [ZERO-LANG-REVIEW.md](ZERO-LANG-REVIEW.md)     | Full technical review of Zero v0.1.3 (vercel-labs/zero)                                                | COMPLETE — reviewed 2026-05-19       |

## Origin

These documents originated from our workspace and were copied here for version control and team visibility. The authoritative copies live in our workspace; these are synchronized snapshots.

## Related

- **Ambitions Comms** (`~/.openclaw/comms/`) — The first subsystem instrumented with structured diagnostics (v0.1.0 of the spec)
- **OpenClaw Fork** — This repo. Our enforcement teeth (Bug #65374, Phase 3) are in `src/` and `test/`
