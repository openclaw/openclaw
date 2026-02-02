# Ticket 05 — Agents List + Detail Wiring

## Goal
Replace mock agent data with live gateway data, and wire agent detail screens to real config + session data.

## Background
- Agents in `apps/web` currently derived from `config.get` or mock data.
- Gateway already supports `agents.list` and `agent.identity.get`.
- Opus agent config design: `apps/web/ux-opus-design/08-AGENT-CONFIGURATION-DESIGN.md`.

## Scope
- Agent list uses `agents.list`.
- Agent detail uses `agent.identity.get` and `sessions.list` for stats.
- Agent config changes use `config.patch` to `agents.*` overrides.

## Requirements
1. **Agent list**
   - Replace mock list with `agents.list`.
2. **Agent detail**
   - Use `sessions.list` to show recent sessions for agent.
   - Use `agent.identity.get` for identity summary.
3. **Per‑agent config editing**
   - Use `config.patch` to update per‑agent overrides (Basics/Tools/etc.).
   - Maintain baseHash and patch merge semantics.

## Fixed Decisions (Do Not Re‑decide)
- Agent list uses `agents.list` (not `config.get`).
- Agent identity uses `agent.identity.get` (not `agents.list`).
- Session stats use `sessions.list` with `agentId` filter.

## Required Decisions (Blockers)
1. **Per‑agent config paths**
   - **Question:** which config paths should the UI patch for per‑agent overrides?
   - **Allowed answers:** explicit key list derived from `apps/web/ux-opus-design/00-CANONICAL-CONFIG-AND-TERMS.md`
   - **Required response format:** table with `ui_section`, `config_key_path`, `value_type`.

## Files to Touch (expected)
- `apps/web/src/hooks/queries/useAgents.ts`
- `apps/web/src/routes/agents/$agentId.tsx`
- `apps/web/src/components/domain/agents/*`
- `apps/web/src/hooks/mutations/useAgentMutations.ts`

## Acceptance Criteria
- Agent list shows actual gateway agents.
- Agent detail shows live identity + recent sessions.
- Editing agent settings persists via `config.patch`.

## Testing
- Manual: verify agent list matches gateway config.
- Manual: change agent setting, refresh, and confirm persistence.
