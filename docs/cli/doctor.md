---
summary: "CLI reference for `mullusi doctor` (health checks + guided repairs)"
read_when:
  - You have connectivity/auth issues and want guided fixes
  - You updated and want a sanity check
title: "doctor"
---

# `mullusi doctor`

Health checks + quick fixes for the gateway and channels.

Related:

- Troubleshooting: [Troubleshooting](/gateway/troubleshooting)
- Security audit: [Security](/gateway/security)

## Examples

```bash
mullusi doctor
mullusi doctor --repair
mullusi doctor --deep
mullusi doctor --repair --non-interactive
mullusi doctor --generate-gateway-token
```

## Options

- `--no-workspace-suggestions`: disable workspace memory/search suggestions
- `--yes`: accept defaults without prompting
- `--repair`: apply recommended repairs without prompting
- `--fix`: alias for `--repair`
- `--force`: apply aggressive repairs, including overwriting custom service config when needed
- `--non-interactive`: run without prompts; safe migrations only
- `--generate-gateway-token`: generate and configure a gateway token
- `--deep`: scan system services for extra gateway installs

Notes:

- Interactive prompts (like keychain/OAuth fixes) only run when stdin is a TTY and `--non-interactive` is **not** set. Headless runs (cron, Telegram, no terminal) will skip prompts.
- `--fix` (alias for `--repair`) writes a backup to `~/.mullusi/mullusi.json.bak` and drops unknown config keys, listing each removal.
- State integrity checks now detect orphan transcript files in the sessions directory and can archive them as `.deleted.<timestamp>` to reclaim space safely.
- Doctor also scans `~/.mullusi/cron/jobs.json` (or `cron.store`) for legacy cron job shapes and can rewrite them in place before the scheduler has to auto-normalize them at runtime.
- Doctor auto-migrates legacy flat Talk config (`talk.voiceId`, `talk.modelId`, and friends) into `talk.provider` + `talk.providers.<provider>`.
- Repeat `doctor --fix` runs no longer report/apply Talk normalization when the only difference is object key order.
- Doctor includes a memory-search readiness check and can recommend `mullusi configure --section model` when embedding credentials are missing.
- If sandbox mode is enabled but Docker is unavailable, doctor reports a high-signal warning with remediation (`install Docker` or `mullusi config set agents.defaults.sandbox.mode off`).
- If `gateway.auth.token`/`gateway.auth.password` are SecretRef-managed and unavailable in the current command path, doctor reports a read-only warning and does not write plaintext fallback credentials.
- If channel SecretRef inspection fails in a fix path, doctor continues and reports a warning instead of exiting early.
- Telegram `allowFrom` username auto-resolution (`doctor --fix`) requires a resolvable Telegram token in the current command path. If token inspection is unavailable, doctor reports a warning and skips auto-resolution for that pass.

## macOS: `launchctl` env overrides

If you previously ran `launchctl setenv MULLUSI_GATEWAY_TOKEN ...` (or `...PASSWORD`), that value overrides your config file and can cause persistent “unauthorized” errors.

```bash
launchctl getenv MULLUSI_GATEWAY_TOKEN
launchctl getenv MULLUSI_GATEWAY_PASSWORD

launchctl unsetenv MULLUSI_GATEWAY_TOKEN
launchctl unsetenv MULLUSI_GATEWAY_PASSWORD
```
