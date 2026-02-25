---
summary: "Secrets management: SecretRef contract, runtime snapshot behavior, and migration"
read_when:
  - Configuring SecretRefs for providers, auth profiles, skills, or Google Chat
  - Operating secrets reload/migrate safely in production
  - Understanding fail-fast and last-known-good behavior
title: "Secrets Management"
---

# Secrets management

OpenClaw supports additive secret references so credentials do not need to be stored in plaintext config files.

Plaintext still works. Secret refs are optional.

## Goals and runtime model

Secrets are resolved into an in-memory runtime snapshot.

- Resolution is eager during activation (not lazy on request paths).
- Startup fails fast if any required ref cannot be resolved.
- Reload uses atomic swap: full success or keep last-known-good.
- Runtime requests use the active in-memory snapshot.

This keeps external secret source outages off the hot request path.

## Onboarding reference preflight

When onboarding runs in interactive mode and you choose secret reference storage, OpenClaw performs a fast preflight check before saving:

- Env refs: validates env var name and confirms a non-empty value is visible during onboarding.
- File refs (`sops`): validates `secrets.sources.file`, decrypts, and resolves the JSON pointer.

If validation fails, onboarding shows the error and lets you retry with a different ref/source.

## SecretRef contract

Use one object shape everywhere:

```json5
{ source: "env" | "file", id: "..." }
```

### `source: "env"`

```json5
{ source: "env", id: "OPENAI_API_KEY" }
```

Validation:

- `id` must match `^[A-Z][A-Z0-9_]{0,127}$`
- Example error: `Env secret reference id must match /^[A-Z][A-Z0-9_]{0,127}$/ (example: "OPENAI_API_KEY").`

### `source: "file"`

```json5
{ source: "file", id: "/providers/openai/apiKey" }
```

Validation:

- `id` must be an absolute JSON pointer (`/...`)
- Use RFC6901 token escaping in segments: `~` => `~0`, `/` => `~1`
- Example error: `File secret reference id must be an absolute JSON pointer (example: "/providers/openai/apiKey").`

## v1 secret sources

### Environment source

No extra config required for resolution.

Optional explicit config:

```json5
{
  secrets: {
    sources: {
      env: { type: "env" },
    },
  },
}
```

### Encrypted file source (`sops`)

```json5
{
  secrets: {
    sources: {
      file: {
        type: "sops",
        path: "~/.openclaw/secrets.enc.json",
        timeoutMs: 5000,
      },
    },
  },
}
```

Contract:

- OpenClaw shells out to `sops` for decrypt/encrypt.
- Minimum supported version: `sops >= 3.9.0`.
- For migration, OpenClaw explicitly passes `--config <config-dir>/.sops.yaml` (or `.sops.yml`), runs `sops` with `cwd=<config-dir>`, and sets `--filename-override` to the absolute target secrets path (for example `/home/user/.openclaw/secrets.enc.json`) so strict `creation_rules` still match even though encryption uses a temp input file.
- Decrypted payload must be a JSON object.
- `id` is resolved as JSON pointer into decrypted payload.
- Default timeout is `5000ms`.

Common errors:

- Missing binary: `sops binary not found in PATH. Install sops >= 3.9.0 or disable secrets.sources.file.`
- Timeout: `sops decrypt timed out after <n>ms for <path>.`
- Missing creation rules/key access (common during migrate write): `config file not found, or has no creation rules, and no keys provided through command line options`

Fix for creation-rules/key-access errors:

- Ensure `<config-dir>/.sops.yaml` or `<config-dir>/.sops.yml` contains a valid `creation_rules` entry for your secrets file.
- Ensure the runtime environment for `openclaw secrets migrate --write` can access decryption/encryption keys (for example `SOPS_AGE_KEY_FILE` for age keys).
- Re-run migration after confirming both config and key access.

## In-scope fields (v1)

### `~/.openclaw/openclaw.json`

- `models.providers.<provider>.apiKey`
- `skills.entries.<skillKey>.apiKey`
- `channels.googlechat.serviceAccount`
- `channels.googlechat.serviceAccountRef`
- `channels.googlechat.accounts.<accountId>.serviceAccount`
- `channels.googlechat.accounts.<accountId>.serviceAccountRef`

### `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`

- `profiles.<profileId>.keyRef` for `type: "api_key"`
- `profiles.<profileId>.tokenRef` for `type: "token"`

OAuth credential storage changes are out of scope for this sprint.

## Required vs optional behavior

- Optional field with no ref: ignored.
- Field with a ref: required at activation time.
- If both plaintext and ref exist, ref wins at runtime and plaintext is ignored.

Warning code used for that override:

- `SECRETS_REF_OVERRIDES_PLAINTEXT`

## Activation triggers

Secret activation is attempted on:

- Startup (preflight + final activation)
- Config reload hot-apply path
- Config reload restart-check path
- Manual reload via `secrets.reload`

Activation contract:

- If activation succeeds, snapshot swaps atomically.
- If activation fails on startup, gateway startup fails.
- If activation fails during runtime reload, active snapshot remains last-known-good.

## Degraded and recovered operator signals

When reload-time activation fails after a healthy state, OpenClaw enters degraded secrets state.

One-shot system event and log codes:

- `SECRETS_RELOADER_DEGRADED`
- `SECRETS_RELOADER_RECOVERED`

Behavior:

- Degraded: runtime keeps last-known-good snapshot.
- Recovered: emitted once after successful activation.
- Repeated failures while already degraded only log warnings (no repeated system events).
- Startup fail-fast does not emit degraded events because no runtime snapshot is active yet.

## Migration command

Use `openclaw secrets migrate` to move plaintext static secrets into file-backed refs.

Default is dry-run:

```bash
openclaw secrets migrate
```

Apply changes:

```bash
openclaw secrets migrate --write
```

Rollback by backup id:

```bash
openclaw secrets migrate --rollback 20260224T193000Z
```

What migration covers:

- `openclaw.json` fields listed above
- `auth-profiles.json` API key and token plaintext fields
- optional scrub of matching plaintext values from config-dir `.env` (default on)
- if `<config-dir>/.sops.yaml` or `<config-dir>/.sops.yml` exists, migration uses it explicitly for sops decrypt/encrypt

`.env` scrub semantics:

- Scrub target path is `<config-dir>/.env` (`resolveConfigDir(...)`), not `OPENCLAW_HOME/.env`.
- Only known secret env keys are eligible (for example `OPENAI_API_KEY`).
- A line is removed only when its parsed value exactly matches a migrated plaintext value.
- Non-secret keys, comments, and unmatched values are preserved.

Backups:

- Path: `~/.openclaw/backups/secrets-migrate/<backupId>/`
- Manifest: `manifest.json`
- Retention: 20 backups

## `auth.json` compatibility notes

For static credentials, OpenClaw runtime no longer depends on plaintext `auth.json`.

- Runtime credential source is the resolved in-memory snapshot.
- Legacy `auth.json` static `api_key` entries are scrubbed when discovered.
- OAuth-related legacy compatibility behavior remains separate.

## Related docs

- CLI commands: [secrets](/cli/secrets)
- Auth setup: [Authentication](/gateway/authentication)
- Security posture: [Security](/gateway/security)
- Environment precedence: [Environment Variables](/help/environment)
