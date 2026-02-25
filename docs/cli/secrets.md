---
summary: "CLI reference for `openclaw secrets` (reload and migration operations)"
read_when:
  - Re-resolving secret refs at runtime
  - Migrating plaintext secrets into file-backed refs
  - Rolling back secrets migration backups
title: "secrets"
---

# `openclaw secrets`

Secrets runtime controls.

Related:

- Secrets guide: [Secrets Management](/gateway/secrets)
- Security guide: [Security](/gateway/security)

## Reload runtime snapshot

Re-resolve secret refs and atomically swap runtime snapshot.

```bash
openclaw secrets reload
openclaw secrets reload --json
```

Notes:

- Uses gateway RPC method `secrets.reload`.
- If resolution fails, gateway keeps last-known-good snapshot.
- JSON response includes `warningCount`.

## Migrate plaintext secrets

Dry-run by default:

```bash
openclaw secrets migrate
openclaw secrets migrate --json
```

Apply changes:

```bash
openclaw secrets migrate --write
```

Skip `.env` scrubbing:

```bash
openclaw secrets migrate --write --no-scrub-env
```

`.env` scrub details (default behavior):

- Scrub target is `<config-dir>/.env`.
- Only known secret env keys are considered.
- Entries are removed only when the value exactly matches a migrated plaintext secret.
- If `<config-dir>/.sops.yaml` or `<config-dir>/.sops.yml` exists, migrate passes it explicitly to `sops`, runs `sops` with `cwd=<config-dir>`, and sets `--filename-override` to the absolute target secrets path (for example `/home/user/.openclaw/secrets.enc.json`) so strict `creation_rules` continue to match when OpenClaw encrypts through a temp file.

Common migrate write failure:

- `config file not found, or has no creation rules, and no keys provided through command line options`

If you hit this:

- Add or fix `<config-dir>/.sops.yaml` / `.sops.yml` with valid `creation_rules`.
- Ensure key access is available in the command environment (for example `SOPS_AGE_KEY_FILE`).
- Re-run `openclaw secrets migrate --write`.

Rollback a previous migration:

```bash
openclaw secrets migrate --rollback <backup-id>
```

## Migration outputs

- Dry-run: prints what would change.
- Write mode: prints backup id and moved secret count.
- Rollback: restores files from the selected backup manifest.

Backups live under:

- `~/.openclaw/backups/secrets-migrate/<backupId>/manifest.json`

## Examples

### Preview migration impact

```bash
openclaw secrets migrate --json | jq '{mode, changed, counters, changedFiles}'
```

### Apply migration and keep a machine-readable record

```bash
openclaw secrets migrate --write --json > /tmp/openclaw-secrets-migrate.json
```

### Force a reload after updating gateway env visibility

```bash
# Ensure OPENAI_API_KEY is visible to the running gateway process first,
# then re-resolve refs:
openclaw secrets reload
```
