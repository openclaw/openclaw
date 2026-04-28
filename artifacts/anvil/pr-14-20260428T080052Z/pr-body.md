## Summary

The cloud-mirror daemon now reads `instanceId` from `~/.openclaw/openclaw.json` (or `BENCH_INSTANCE_ID` env override) and scopes its filesystem footprint per-instance.

## Why

Phase D2.1 — when multiple Bench instances eventually share infrastructure (Tier B local, Tier C cloud), the cloud-mirror daemon needs to:

1. Watch only its instance's vault (not all of `~/.openclaw/wiki/`).
2. Keep a separate state file per instance so switching `instanceId` doesn't re-POST the previous vault.
3. Stamp each ingest payload with `sourceInstanceId` so the cloud side (`/api/v1/wiki/ingest`) can attribute deltas correctly.

## Changes

- `extensions/claude-code-bridge/cloud-mirror.mjs`:
  - `readInstanceIdFromConfig()` — reads `instanceId` from openclaw.json (env override first), validates against `/^[A-Za-z0-9_-]{1,128}$/` (local copy of the same regex used in `src/config/zod-schema.ts` — daemon runs without TS toolchain).
  - `VAULT_DIR` derived from `~/.openclaw/wiki/{instanceId || "main"}/`.
  - State file becomes `wiki-mirror.{instanceId}.json` when scoped, `wiki-mirror.json` otherwise.
  - Each scanned entry includes `sourceInstanceId` (when set) for upstream tagging.
  - Startup log now includes the resolved `instanceId`.

## Stacked PR

Stacked on #11. Once #11 merges, GitHub auto-rebases this onto `main`.

## Test plan

- [x] Pre-commit hooks green
- [ ] Manual smoke (deferred, post-merge): set `BENCH_INSTANCE_ID=test-shard`, verify `~/.openclaw/state/wiki-mirror.test-shard.json` is created when the daemon runs and deltas hit `/api/v1/wiki/ingest` with `sourceInstanceId: "test-shard"`.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

## Anvil Handoff

- Hammer summary: Cloud-mirror daemon (`.mjs`, no TS) reads `instanceId` from `~/.openclaw/openclaw.json` (or `BENCH_INSTANCE_ID` env override) at startup. Watches per-instance vault, uses per-instance state file `wiki-mirror.{instanceId}.json`, stamps `sourceInstanceId` on each ingest payload. Validation regex is a third local copy of `[A-Za-z0-9_-]{1,128}`. Stacked on #11.
- Primary paths changed: `extensions/claude-code-bridge/cloud-mirror.mjs`
- Verification run: No automated test (long-running daemon). Pre-commit green.
- Known risks: (1) Switching `instanceId` orphans the previous `wiki-mirror.json` state and triggers a full re-POST of the new vault — confirm cloud-side `/api/v1/wiki/ingest` handles re-POST of pre-existing slugs without duplicate creation. (2) `BENCH_INSTANCE_ID` env override bypasses the openclaw.json check entirely; intentional for advanced/test scenarios but worth verifying it doesn`'t shadow operational misconfig. (3) Read-side bundle hooks need to honor `sourceInstanceId`for tenant scoping — confirm a paired`BenchAGI_Mono_Repo` PR is wired or in-flight.
- Suggested Anvil focus: Manual smoke: `BENCH_INSTANCE_ID=test-shard node extensions/claude-code-bridge/cloud-mirror.mjs` — verify (a) `~/.openclaw/state/wiki-mirror.test-shard.json` is created, (b) ingest payloads include `sourceInstanceId: "test-shard"`. Diff the regex constants across this PR + #11 + #13 byte-for-byte. Confirm the `sourceInstanceId` field name matches what the cloud-side ingest endpoint expects.
