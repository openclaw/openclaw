---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Harden cron.add input handling, align schemas, and improve cron UI/agent tooling"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
owner: "openclaw"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
status: "complete"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
last_updated: "2026-01-05"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Cron Add Hardening"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Cron Add Hardening & Schema Alignment（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Context（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Recent gateway logs show repeated `cron.add` failures with invalid parameters (missing `sessionTarget`, `wakeMode`, `payload`, and malformed `schedule`). This indicates that at least one client (likely the agent tool call path) is sending wrapped or partially specified job payloads. Separately, there is drift between cron provider enums in TypeScript, gateway schema, CLI flags, and UI form types, plus a UI mismatch for `cron.status` (expects `jobCount` while gateway returns `jobs`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Goals（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Stop `cron.add` INVALID_REQUEST spam by normalizing common wrapper payloads and inferring missing `kind` fields.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Align cron provider lists across gateway schema, cron types, CLI docs, and UI forms.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Make agent cron tool schema explicit so the LLM produces correct job payloads.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Fix the Control UI cron status job count display.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Add tests to cover normalization and tool behavior.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Non-goals（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Change cron scheduling semantics or job execution behavior.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Add new schedule kinds or cron expression parsing.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Overhaul the UI/UX for cron beyond the necessary field fixes.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Findings (current gaps)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `CronPayloadSchema` in gateway excludes `signal` + `imessage`, while TS types include them.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Control UI CronStatus expects `jobCount`, but gateway returns `jobs`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agent cron tool schema allows arbitrary `job` objects, enabling malformed inputs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gateway strictly validates `cron.add` with no normalization, so wrapped payloads fail.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## What changed（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `cron.add` and `cron.update` now normalize common wrapper shapes and infer missing `kind` fields.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agent cron tool schema matches the gateway schema, which reduces invalid payloads.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Provider enums are aligned across gateway, CLI, UI, and macOS picker.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Control UI uses the gateway’s `jobs` count field for status.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Current behavior（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Normalization:** wrapped `data`/`job` payloads are unwrapped; `schedule.kind` and `payload.kind` are inferred when safe.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Defaults:** safe defaults are applied for `wakeMode` and `sessionTarget` when missing.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Providers:** Discord/Slack/Signal/iMessage are now consistently surfaced across CLI/UI.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
See [Cron jobs](/automation/cron-jobs) for the normalized shape and examples.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Verification（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Watch gateway logs for reduced `cron.add` INVALID_REQUEST errors.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Confirm Control UI cron status shows job count after refresh.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Optional Follow-ups（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Manual Control UI smoke: add a cron job per provider + verify status job count.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Open Questions（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Should `cron.add` accept explicit `state` from clients (currently disallowed by schema)?（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Should we allow `webchat` as an explicit delivery provider (currently filtered in delivery resolution)?（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
