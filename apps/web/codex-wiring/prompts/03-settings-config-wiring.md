# Ticket 03 — System Settings Wiring (Config + Models + Usage)

## Goal
Make system settings fully live using gateway config APIs and model listings, aligned with Opus settings design.

## Background
- Opus settings spec: `apps/web/ux-opus-design/07-SYSTEM-SETTINGS-DESIGN.md`.
- Canonical keys: `apps/web/ux-opus-design/00-CANONICAL-CONFIG-AND-TERMS.md`.
- Current settings UI is partial or mock‑backed.

## Scope
- Wire all settings panels to `config.get`, `config.schema`, `config.patch`, `config.apply`.
- Use `models.list` for model list + capability gating.
- Wire usage metrics to gateway `usage.status` / `usage.cost`.
- Replace browser‑side provider key verification with gateway RPC.

## Requirements
1. **Config snapshot + schema**
   - `config.get` + `config.schema` power DynamicConfigSection.
2. **Config updates**
   - Use `config.patch` for partial updates with `baseHash`.
   - `config.apply` for full import flows (if used).
3. **Model/provider**
   - Use `models.list` for model selector and provider model availability.
   - Replace direct provider HTTP verification with gateway‑side verification RPC.
4. **Usage/Billing**
   - Display real usage data from `usage.status` / `usage.cost`.

## Fixed Decisions (Do Not Re‑decide)
- `config.patch` must include `baseHash` from the latest `config.get` snapshot (`configSnapshot.hash`).
- Model list is always sourced from `models.list` (no static lists).

## Required Decisions (Blocker)
Add a **single explicit choice** here before implementation:
1. **Provider verification RPC name + shape**
   - **Question:** what RPC should the UI call to validate provider API keys?
   - **Allowed answers (pick one):**
     - `provider.verify`
     - `models.verify`
     - `auth.provider.verify`
   - **Required response format:** a short table with `method`, `params`, `result`, `error` fields.
2. **Usage polling cadence**
   - **Question:** how often should UI poll `usage.status` / `usage.cost`?
   - **Allowed answers:** `15s`, `30s`, `60s`, `manual-only`
   - **Required response format:** a single literal value from the list above.

## Files to Touch (expected)
- `apps/web/src/components/domain/settings/ModelProviderSection.tsx`
- `apps/web/src/components/domain/settings/GatewaySection.tsx`
- `apps/web/src/components/domain/settings/UsageSection.tsx`
- `apps/web/src/hooks/queries/useConfig.ts`
- `apps/web/src/hooks/mutations/useConfigMutations.ts`
- `apps/web/src/lib/api/config.ts`

## New/Changed RPCs Needed
- **`provider.verify`** (or similar) gateway RPC to validate API keys.
  - UI should no longer call external provider HTTP endpoints directly.

## Acceptance Criteria
- Settings pages reflect live gateway config.
- Provider config changes persist via `config.patch`.
- Usage panel shows real usage from gateway.

## Testing
- Manual: change a setting, verify persists after refresh.
- Manual: verify provider API key via gateway RPC and see models list update.
