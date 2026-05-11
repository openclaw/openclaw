# Polytropos Roadmap (OpenClaw fork)

This roadmap turns the OpenClaw → Polytropos fork into a plugin-first architecture with a repeatable migration workflow.

## Invariants (non-negotiable)

- **Runtime config stability:** keep `~/.openclaw/openclaw.json` stable as default.
- **Extensions deploy location:** `~/.openclaw/extensions/<pluginId>`
- **Manifest location:** OpenClaw expects plugin manifest at **`<pluginRoot>/dist/openclaw.plugin.json`** for plugins packaged by the monorepo.
- **Plugin root rule:** OpenClaw must be pointed at the directory that **contains the manifest**.
- **Dev vs prod deploy:**
  - dev: symlink (fast iteration)
  - prod: copy (release-style)

## Milestones

### M0 — Baseline & toolchain locks
- [x] Nx + pnpm monorepo for plugins (`polytropos-plugins`)
- [x] sanitize-guard migrated and loading
- [x] Remove duplicate/legacy plugin deployments that create doctor warnings
- [x] Add artifact verification scripts to make wrong deploy impossible

**Acceptance:**
- `pnpm verify:plugin sanitize-guard` passes
- `pnpm verify:doctor-plugin sanitize-guard` passes
- `openclaw plugins list` shows sanitize-guard loaded from `~/.openclaw/extensions/sanitize-guard/...`

### M1 — Fork skeleton (openclaw-polytropos)
- [ ] Create minimal fork deltas: Polytropos namespace + extension loading seams
- [ ] Document the compatibility model (what stays hook-only vs capability registration)
- [ ] CI / local dev loop documented
- [ ] Maintain canonical docs under [`docs/polytropos/`](../../polytropos/)

**Acceptance:** fork runs with existing `~/.openclaw/openclaw.json`.

### M2 — Codify deploy correctness (never again)
- [x] Deploy script resolves manifest directory automatically
- [x] Verify script validates artifact layout and manifest entry
- [x] Doctor gate per plugin

**Acceptance:** migrations cannot introduce path/id mismatch warnings without failing a verify step.

### M3 — Migrate restart-resume to monorepo
- [ ] Move restart-resume source into `polytropos-plugins/plugins/restart-resume`
- [ ] Standard build/pack/deploy targets
- [ ] Remove workspace copy from load path (leave disabled backup)

**Acceptance:** `openclaw doctor` has no duplicate-id warnings; plugin loads from monorepo deployment.

### M4 — Migrate remaining workflow-critical plugins
Suggested order:
1. transcript-hygiene
2. system-prompt-logger
3. channel-context-overlay
4. context-overflow-* plugins
5. discord-reminder-crond

Each migration must include:
- deploy-dev/prod targets
- `verify:plugin` pass
- `verify:doctor-plugin` pass
- runtime behavior check
