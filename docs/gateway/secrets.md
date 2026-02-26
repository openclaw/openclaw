---
summary: "Secrets management: SecretRef contract, runtime snapshot behavior, and safe one-way scrubbing"
read_when:
  - Configuring SecretRefs for providers, auth profiles, skills, or Google Chat
  - Operating secrets reload/audit/configure/apply safely in production
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
- Enable `allowSymlinkCommand` only when required for trusted package-manager paths, and pair it with `trustedDirs` (for example `["/opt/homebrew"]`).
- When `trustedDirs` is set, checks apply to the resolved target path.
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

## Audit and configure workflow

Use this default operator flow:

```bash
openclaw secrets audit --check
openclaw secrets configure
openclaw secrets audit --check
```

Migration completeness:

- Include `skills.entries.<skillKey>.apiKey` targets when those skills use API keys.
- If `audit --check` still reports plaintext findings after a partial migration, migrate the remaining reported paths and rerun audit.

### `secrets audit`

Findings include:

- plaintext values at rest (`openclaw.json`, `auth-profiles.json`, `.env`)
- unresolved refs
- precedence shadowing (`auth-profiles` taking priority over config refs)
- legacy residues (`auth.json`, OAuth out-of-scope reminders)

### `secrets configure`

Interactive helper that:

- configures `secrets.providers` first (`env`/`file`/`exec`, add/edit/remove)
- lets you select secret-bearing fields in `openclaw.json`
- captures SecretRef details (`source`, `provider`, `id`)
- runs preflight resolution
- can apply immediately

Helpful modes:

- `openclaw secrets configure --providers-only`
- `openclaw secrets configure --skip-provider-setup`

`configure` apply defaults to:

- scrub matching static creds from `auth-profiles.json` for targeted providers
- scrub legacy static `api_key` entries from `auth.json`
- scrub matching known secret lines from `<config-dir>/.env`

### `secrets apply`

Apply a saved plan:

```bash
openclaw secrets apply --from /tmp/openclaw-secrets-plan.json
openclaw secrets apply --from /tmp/openclaw-secrets-plan.json --dry-run
```

For strict target/path contract details and exact rejection rules, see:

- [Secrets Apply Plan Contract](/gateway/secrets-plan-contract)

## One-way safety policy

OpenClaw intentionally does **not** write rollback backups that contain pre-migration plaintext secret values.

Safety model:

- preflight must succeed before write mode
- runtime activation is validated before commit
- apply updates files using atomic file replacement and best-effort in-memory restore on failure

## `auth.json` compatibility notes

For static credentials, OpenClaw runtime no longer depends on plaintext `auth.json`.

- Runtime credential source is the resolved in-memory snapshot.
- Legacy `auth.json` static `api_key` entries are scrubbed when discovered.
- OAuth-related legacy compatibility behavior remains separate.

## Related docs

- CLI commands: [secrets](/cli/secrets)
- Plan contract details: [Secrets Apply Plan Contract](/gateway/secrets-plan-contract)
- Auth setup: [Authentication](/gateway/authentication)
- Security posture: [Security](/gateway/security)
- Environment precedence: [Environment Variables](/help/environment)
