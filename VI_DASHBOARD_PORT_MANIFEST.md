## VI Dashboard Port Manifest

Target branch: `integration/v2026.4.20-vi-dashboard`

Source branch: `manhhai999/release/v2026.4.15-vi-dashboard`

Source delta basis: final tree diff against `v2026.4.15`

Goals:

- Keep the new work fully isolated from the currently running runtime.
- Rebuild the VI dashboard customizations on top of upstream `v2026.4.20`.
- Preserve the review surface first, then preserve supporting runtime/status behavior.
- Regenerate generated artifacts on the `v2026.4.20` codebase instead of copying stale generated outputs from `v2026.4.15`.

Rules:

- Do not touch the currently running runtime or the existing `openclaw-v2026.4.15-vi-dashboard` checkout.
- Treat `ui/src/i18n/locales/*.ts`, `ui/src/i18n/.i18n/*.meta.json`, and `ui/src/ui/views/config-form.metadata.generated.ts` as generated output.
- Port source-of-truth inputs first, then regenerate generated output on the new branch.
- Prefer final-tree forward-porting over raw history replay because the source branch contains a large snapshot commit plus later hotfixes.

## Bucket 1: UI And I18n

Intent:

- Recreate the dashboard review surface and VI localization behavior on top of the new UI/runtime contracts in `v2026.4.20`.

Primary source-of-truth files:

- `scripts/control-ui-i18n.ts`
- `ui/src/i18n/.i18n/glossary.vi.json`
- `ui/src/i18n/.i18n/vi.tm.jsonl`
- `ui/src/i18n/lib/registry.ts`
- `ui/src/i18n/lib/types.ts`
- `ui/src/styles/layout.css`
- `ui/src/styles/layout.mobile.css`
- `ui/src/ui/app-render.helpers.ts`
- `ui/src/ui/app-render.ts`
- `ui/src/ui/controllers/config.ts`
- `ui/src/ui/views/agents-panels-overview.ts`
- `ui/src/ui/views/agents-panels-status-files.ts`
- `ui/src/ui/views/agents-panels-tools-skills.ts`
- `ui/src/ui/views/agents-utils.ts`
- `ui/src/ui/views/agents.ts`
- `ui/src/ui/views/channels.config.ts`
- `ui/src/ui/views/config-form.metadata.ts`
- `ui/src/ui/views/config-form.node.ts`
- `ui/src/ui/views/config-form.render.ts`
- `ui/src/ui/views/config-form.ts`
- `ui/src/ui/views/config.ts`
- `ui/src/ui/views/dreaming.ts`
- `ui/src/ui/views/logs.ts`
- `ui/src/ui/views/nodes-exec-approvals.ts`
- `ui/src/ui/views/nodes.ts`
- `ui/src/ui/views/sessions.ts`
- `ui/src/ui/views/skills-grouping.ts`
- `ui/src/ui/views/skills.ts`

Generated outputs to regenerate after source port:

- `ui/src/i18n/locales/*.ts`
- `ui/src/i18n/.i18n/*.meta.json`
- `ui/src/ui/views/config-form.metadata.generated.ts`

Supporting tests in scope:

- `ui/src/i18n/test/translate.test.ts`
- `ui/src/ui/config-form.browser.test.ts`
- `ui/src/ui/controllers/config.test.ts`
- `ui/src/ui/navigation.browser.test.ts`
- `ui/src/ui/views/agents-panels-tools-skills.browser.test.ts`
- `ui/src/ui/views/chat.test.ts`
- `ui/src/ui/views/config.browser.test.ts`
- `ui/src/ui/views/skills.test.ts`

Status: pending

## Bucket 2: Status And Dashboard Runtime

Intent:

- Preserve the status/dashboard data shape and fast-path behavior that the custom dashboard depends on.

Files in scope:

- `src/channels/plugins/status-read.ts`
- `src/commands/status-all/channels.ts`
- `src/commands/status.command-sections.ts`
- `src/commands/status.command.ts`
- `src/commands/status.link-channel.ts`
- `src/commands/status.scan-overview.ts`
- `src/commands/status.scan.bootstrap-shared.ts`
- `src/commands/status.scan.fast-json.ts`
- `src/commands/status.scan.runtime.ts`
- `src/commands/status.scan.ts`
- `src/commands/status.summary.ts`
- `src/config/io.ts`
- `src/infra/channel-summary.ts`
- `src/plugins/memory-runtime.ts`
- `src/plugins/status.ts`

Supporting tests in scope:

- `src/commands/status.command-sections.test.ts`
- `src/commands/status.scan-overview.test.ts`
- `src/commands/status.scan.fast-json.test.ts`
- `src/commands/status.scan.test.ts`
- `src/plugins/memory-runtime.test.ts`
- `src/plugins/status.test.ts`

Status: pending

## Bucket 3: Compatibility, Ops, And Guardrails

Intent:

- Carry forward the small but important custom guardrails and compatibility changes that are part of the shipped branch behavior.

Files in scope:

- `.github/workflows/ci.yml`
- `.github/workflows/install-smoke.yml`
- `.github/workflows/labeler.yml`
- `.github/workflows/openclaw-cross-os-release-checks-reusable.yml`
- `.github/workflows/openclaw-release-checks.yml`
- `.github/workflows/openclaw-scheduled-live-checks.yml`
- `.github/workflows/parity-gate.yml`
- `.github/workflows/workflow-sanity.yml`
- `extensions/telegram/src/bot.ts`
- `package.json`
- `pnpm-lock.yaml`
- `src/agents/sandbox/docker.ts`
- `src/gateway/server.canvas-auth.test.ts`
- `src/i18n/registry.test.ts`

Status: pending

## Migration Order

1. Port bucket 1 source-of-truth UI/i18n files.
2. Regenerate UI generated artifacts on the `v2026.4.20` branch.
3. Port bucket 2 runtime/status behavior.
4. Port bucket 3 compatibility and ops deltas.
5. Run targeted tests, then broader build/check on the new branch only.

## Verification Target

- `pnpm ui:i18n:check`
- Targeted UI/status tests
- `pnpm build`
- `pnpm check:changed`

## Runtime Safety

- No config writes, service restarts, or runtime changes against the currently running environment are allowed during this migration.
- All verification stays inside `/home/manhhai/openclaw-v2026.4.20-vi-dashboard`.
