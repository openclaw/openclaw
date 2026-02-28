---
summary: "Secrets management: SecretRef contract, runtime snapshot behavior, and safe one-way scrubbing"
read_when:
  - Configuring SecretRefs for provider credentials and auth profile refs
  - Operating secrets reload, audit, configure, and apply safely in production
  - Understanding startup fail-fast, inactive-surface filtering, and last-known-good behavior
title: "Secrets Management"
---

# Secrets management

OpenClaw supports additive SecretRefs so supported credentials do not need to be stored as plaintext in configuration.

Plaintext still works. SecretRefs are opt-in per credential.

## Goals and runtime model

Secrets are resolved into an in-memory runtime snapshot.

- Resolution is eager during activation, not lazy on request paths.
- Startup fails fast when an effectively active SecretRef cannot be resolved.
- Reload uses atomic swap: full success, or keep the last-known-good snapshot.
- Runtime requests read from the active in-memory snapshot only.

This keeps secret-provider outages off hot request paths.

## Active-surface filtering

SecretRefs are validated only on effectively active surfaces.

- Enabled surfaces: unresolved refs block startup/reload.
- Inactive surfaces: unresolved refs do not block startup/reload.
- Inactive refs emit non-fatal diagnostics with code `SECRETS_REF_IGNORED_INACTIVE_SURFACE`.

Examples of inactive surfaces:

- Disabled channel/account entries.
- Top-level channel credentials that no enabled account inherits.
- Disabled tool/feature surfaces.

## Onboarding reference preflight

When onboarding runs in interactive mode and you choose SecretRef storage, OpenClaw runs preflight validation before saving:

- Env refs: validates env var name and confirms a non-empty value is visible during onboarding.
- Provider refs (`file` or `exec`): validates provider selection, resolves `id`, and checks resolved value type.

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
        mode: "json", // or "singleValue"
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
- `mode: "json"` expects JSON object payload and resolves `id` as pointer.
- `mode: "singleValue"` expects ref id `"value"` and returns file contents.
- Path must pass ownership/permission checks.

### Exec provider

- Runs configured absolute binary path, no shell.
- By default, `command` must point to a regular file (not a symlink).
- Set `allowSymlinkCommand: true` to allow symlink command paths (for example Homebrew shims). OpenClaw validates the resolved target path.
- Pair `allowSymlinkCommand` with `trustedDirs` for package-manager paths (for example `["/opt/homebrew"]`).
- Supports timeout, no-output timeout, output byte limits, env allowlist, and trusted dirs.

Request payload (stdin):

```json
{ "protocolVersion": 1, "provider": "vault", "ids": ["providers/openai/apiKey"] }
```

Response payload (stdout):

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

## Exec integration examples

### 1Password CLI

```json5
{
  secrets: {
    providers: {
      onepassword_openai: {
        source: "exec",
        command: "/opt/homebrew/bin/op",
        allowSymlinkCommand: true, // required for Homebrew symlinked binaries
        trustedDirs: ["/opt/homebrew"],
        args: ["read", "op://Personal/OpenClaw QA API Key/password"],
        passEnv: ["HOME"],
        jsonOnly: false,
      },
    },
  },
  models: {
    providers: {
      openai: {
        baseUrl: "https://api.openai.com/v1",
        models: [{ id: "gpt-5", name: "gpt-5" }],
        apiKey: { source: "exec", provider: "onepassword_openai", id: "value" },
      },
    },
  },
}
```

### HashiCorp Vault CLI

```json5
{
  secrets: {
    providers: {
      vault_openai: {
        source: "exec",
        command: "/opt/homebrew/bin/vault",
        allowSymlinkCommand: true, // required for Homebrew symlinked binaries
        trustedDirs: ["/opt/homebrew"],
        args: ["kv", "get", "-field=OPENAI_API_KEY", "secret/openclaw"],
        passEnv: ["VAULT_ADDR", "VAULT_TOKEN"],
        jsonOnly: false,
      },
    },
  },
  models: {
    providers: {
      openai: {
        baseUrl: "https://api.openai.com/v1",
        models: [{ id: "gpt-5", name: "gpt-5" }],
        apiKey: { source: "exec", provider: "vault_openai", id: "value" },
      },
    },
  },
}
```

### `sops`

```json5
{
  secrets: {
    providers: {
      sops_openai: {
        source: "exec",
        command: "/opt/homebrew/bin/sops",
        allowSymlinkCommand: true, // required for Homebrew symlinked binaries
        trustedDirs: ["/opt/homebrew"],
        args: ["-d", "--extract", '["providers"]["openai"]["apiKey"]', "/path/to/secrets.enc.json"],
        passEnv: ["SOPS_AGE_KEY_FILE"],
        jsonOnly: false,
      },
    },
  },
  models: {
    providers: {
      openai: {
        baseUrl: "https://api.openai.com/v1",
        models: [{ id: "gpt-5", name: "gpt-5" }],
        apiKey: { source: "exec", provider: "sops_openai", id: "value" },
      },
    },
  },
}
```

## Supported credential surface

Canonical supported and unsupported credentials are listed in:

- [SecretRef Credential Surface](/reference/secretref-credential-surface)

Runtime-minted or rotating credentials and OAuth refresh material are intentionally excluded from read-only SecretRef resolution.

## Required behavior and precedence

- Field without a ref: unchanged.
- Field with a ref: required on active surfaces during activation.
- If both plaintext and ref are present, ref takes precedence on supported precedence paths.

Warning and audit signals:

- `SECRETS_REF_OVERRIDES_PLAINTEXT` (runtime warning)
- `REF_SHADOWED` (audit finding when auth profile credentials take precedence over config refs)

Google Chat compatibility behavior:

- `serviceAccountRef` takes precedence over plaintext `serviceAccount`.
- Plaintext value is ignored when sibling ref is set.

## Activation triggers

Secret activation runs on:

- Startup (preflight plus final activation)
- Config reload hot-apply path
- Config reload restart-check path
- Manual reload via `secrets.reload`

Activation contract:

- Success swaps the snapshot atomically.
- Startup failure aborts gateway startup.
- Runtime reload failure keeps the last-known-good snapshot.

## Degraded and recovered signals

When reload-time activation fails after a healthy state, OpenClaw enters degraded secrets state.

One-shot system event and log codes:

- `SECRETS_RELOADER_DEGRADED`
- `SECRETS_RELOADER_RECOVERED`

Behavior:

- Degraded: runtime keeps last-known-good snapshot.
- Recovered: emitted once after the next successful activation.
- Repeated failures while already degraded log warnings but do not spam events.
- Startup fail-fast does not emit degraded events because runtime never became active.

## Command-path resolution

Credential-sensitive command paths that opt in (for example `openclaw memory` remote-memory paths and `openclaw qr --remote`) can resolve supported SecretRefs via gateway snapshot RPC.

- When gateway is running, those command paths read from the active snapshot.
- If a configured SecretRef is required and gateway is unavailable, command resolution fails fast with actionable diagnostics.
- Snapshot refresh after backend secret rotation is handled by `openclaw secrets reload`.
- Gateway RPC method used by these command paths: `secrets.resolve`.

## Audit and configure workflow

Default operator flow:

```bash
openclaw secrets audit --check
openclaw secrets configure
openclaw secrets audit --check
```

### `secrets audit`

Findings include:

- plaintext values at rest (`openclaw.json`, `auth-profiles.json`, `.env`)
- unresolved refs
- precedence shadowing (`auth-profiles` taking priority over config refs)
- legacy residues (`auth.json`, OAuth reminders)

### `secrets configure`

Interactive helper that:

- configures `secrets.providers` first (`env`/`file`/`exec`, add/edit/remove)
- lets you select supported secret-bearing fields in `openclaw.json` plus `auth-profiles.json` for one agent scope
- can create a new auth profile mapping directly in the target picker
- captures SecretRef details (`source`, `provider`, `id`)
- runs preflight resolution
- can apply immediately

Helpful modes:

- `openclaw secrets configure --providers-only`
- `openclaw secrets configure --skip-provider-setup`
- `openclaw secrets configure --agent <id>`

`configure` apply defaults:

- scrub matching static credentials from `auth-profiles.json` for targeted providers
- scrub legacy static `api_key` entries from `auth.json`
- scrub matching known secret lines from `<config-dir>/.env`

### `secrets apply`

Apply a saved plan:

```bash
openclaw secrets apply --from /tmp/openclaw-secrets-plan
openclaw secrets apply --from /tmp/openclaw-secrets-plan --dry-run
```

For strict target/path contract details and exact rejection rules, see:

- [Secrets Apply Plan Contract](/gateway/secrets-plan-contract)

## One-way safety policy

OpenClaw intentionally does not write rollback backups containing historical plaintext secret values.

Safety model:

- preflight must succeed before write mode
- runtime activation is validated before commit
- apply updates files using atomic file replacement and best-effort restore on failure

## Legacy auth compatibility notes

For static credentials, runtime no longer depends on plaintext legacy auth storage.

- Runtime credential source is the resolved in-memory snapshot.
- Legacy static `api_key` entries are scrubbed when discovered.
- OAuth-related compatibility behavior remains separate.

## Web UI note

Some SecretInput unions are easier to configure in raw editor mode than in form mode.

## Related docs

- CLI commands: [secrets](/cli/secrets)
- Plan contract details: [Secrets Apply Plan Contract](/gateway/secrets-plan-contract)
- Credential surface: [SecretRef Credential Surface](/reference/secretref-credential-surface)
- Auth setup: [Authentication](/gateway/authentication)
- Security posture: [Security](/gateway/security)
- Environment precedence: [Environment Variables](/help/environment)
