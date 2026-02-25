---
summary: "Secrets management: SecretRef contract, runtime snapshot behavior, and migration"
read_when:
  - Configuring SecretRefs for providers, auth profiles, skills, or Google Chat
  - Operating secrets reload/migrate safely in production
  - Understanding fail-fast and last-known-good behavior
title: "Secrets Management"
---

# Secrets management

OpenClaw supports additive secret references so credentials do not need to be stored as plaintext in config files.

Plaintext still works. Secret refs are optional.

## Goals and runtime model

Secrets are resolved into an in-memory runtime snapshot.

- Resolution is eager during activation, not lazy on request paths.
- Startup fails fast if any referenced credential cannot be resolved.
- Reload uses atomic swap: full success or keep last-known-good.
- Runtime requests read from the active in-memory snapshot.

This keeps secret-provider outages off the hot request path.

## Onboarding reference preflight

When onboarding runs in interactive mode and you choose secret reference storage, OpenClaw performs a fast preflight check before saving:

- Env refs: validates env var name and confirms a non-empty value is visible during onboarding.
- Provider refs (`file` or `exec`): validates the selected provider, resolves the provided `id`, and checks value type.

If validation fails, onboarding shows the error and lets you retry.

## SecretRef contract

Use one object shape everywhere:

```json5
{ source: "env" | "file" | "exec", provider: "default", id: "..." }
```

### `source: "env"`

```json5
{ source: "env", provider: "default", id: "OPENAI_API_KEY" }
```

Validation:

- `provider` must match `^[a-z][a-z0-9_-]{0,63}$`
- `id` must match `^[A-Z][A-Z0-9_]{0,127}$`

### `source: "file"`

```json5
{ source: "file", provider: "filemain", id: "/providers/openai/apiKey" }
```

Validation:

- `provider` must match `^[a-z][a-z0-9_-]{0,63}$`
- `id` must be an absolute JSON pointer (`/...`)
- RFC6901 escaping in segments: `~` => `~0`, `/` => `~1`

### `source: "exec"`

```json5
{ source: "exec", provider: "vault", id: "providers/openai/apiKey" }
```

Validation:

- `provider` must match `^[a-z][a-z0-9_-]{0,63}$`
- `id` must match `^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$`

## Provider config

Define providers under `secrets.providers`:

```json5
{
  secrets: {
    providers: {
      default: { source: "env" },
      filemain: {
        source: "file",
        path: "~/.openclaw/secrets.json",
        mode: "jsonPointer", // or "raw"
      },
      vault: {
        source: "exec",
        command: "/usr/local/bin/openclaw-vault-resolver",
        args: ["--profile", "prod"],
        passEnv: ["PATH", "VAULT_ADDR"],
        jsonOnly: true,
      },
    },
    defaults: {
      env: "default",
      file: "filemain",
      exec: "vault",
    },
    resolution: {
      maxProviderConcurrency: 4,
      maxRefsPerProvider: 512,
      maxBatchBytes: 262144,
    },
  },
}
```

### Env provider

- Optional allowlist via `allowlist`.
- Missing/empty env values fail resolution.

### File provider

- Reads local file from `path`.
- `mode: "jsonPointer"` expects JSON object payload and resolves `id` as pointer.
- `mode: "raw"` expects ref id `"value"` and returns file contents.
- Path must pass ownership/permission checks.

### Exec provider

- Runs configured absolute binary path, no shell.
- Supports timeout, no-output timeout, output byte limits, env allowlist, and trusted dirs.
- Request payload (stdin):

```json
{ "protocolVersion": 1, "provider": "vault", "ids": ["providers/openai/apiKey"] }
```

- Response payload (stdout):

```json
{ "protocolVersion": 1, "values": { "providers/openai/apiKey": "sk-..." } }
```

Optional per-id errors:

```json
{
  "protocolVersion": 1,
  "values": {},
  "errors": { "providers/openai/apiKey": { "message": "not found" } }
}
```

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

OAuth credential storage changes are out of scope.

## Required behavior and precedence

- Field without ref: unchanged.
- Field with ref: required at activation time.
- If plaintext and ref both exist, ref wins at runtime and plaintext is ignored.

Warning code:

- `SECRETS_REF_OVERRIDES_PLAINTEXT`

## Activation triggers

Secret activation is attempted on:

- Startup (preflight plus final activation)
- Config reload hot-apply path
- Config reload restart-check path
- Manual reload via `secrets.reload`

Activation contract:

- Success swaps the snapshot atomically.
- Startup failure aborts gateway startup.
- Runtime reload failure keeps last-known-good snapshot.

## Degraded and recovered operator signals

When reload-time activation fails after a healthy state, OpenClaw enters degraded secrets state.

One-shot system event and log codes:

- `SECRETS_RELOADER_DEGRADED`
- `SECRETS_RELOADER_RECOVERED`

Behavior:

- Degraded: runtime keeps last-known-good snapshot.
- Recovered: emitted once after a successful activation.
- Repeated failures while already degraded log warnings but do not spam events.
- Startup fail-fast does not emit degraded events because no runtime snapshot exists yet.

## Migration command

Use `openclaw secrets migrate` to move plaintext static secrets into file-backed refs.

Dry-run (default):

```bash
openclaw secrets migrate
```

Apply:

```bash
openclaw secrets migrate --write
```

Rollback by backup id:

```bash
openclaw secrets migrate --rollback 20260224T193000Z
```

What migration covers:

- `openclaw.json` fields listed above
- `auth-profiles.json` plaintext API key/token fields
- optional scrub of matching plaintext values from `<config-dir>/.env` (default on)

Migration writes secrets to:

- configured default `file` provider path when present
- otherwise `<state-dir>/secrets.json`

`.env` scrub semantics:

- target path is `<config-dir>/.env`
- only known secret env keys are eligible
- a line is removed only when value exactly matches a migrated plaintext value
- comments/non-secret keys/unmatched values are preserved

Backups:

- path: `~/.openclaw/backups/secrets-migrate/<backupId>/`
- manifest: `manifest.json`
- retention: 20 backups

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
