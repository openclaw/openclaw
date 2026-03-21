---
summary: "Configure exec-backed SecretRefs for external secret managers and local resolver binaries"
read_when:
  - Using `source: "exec"` SecretRefs
  - Wiring OpenClaw to 1Password, Vault, `sops`, or a custom resolver
  - Verifying exec provider stdin/stdout contract and safety constraints
title: "Exec Secret Providers"
---

# Exec secret providers

Use an `exec` provider when a secret should come from an external command instead of plaintext config, a local file, or a process env var.

This page focuses on `source: "exec"` only. For the full SecretRef model and runtime behavior, see [Secrets Management](/gateway/secrets).

## When to use `exec`

Use `exec` providers when you already have a secrets tool that can return values on demand, such as:

- `op` from 1Password CLI
- `sops -d`
- `vault` or a small Vault wrapper
- a custom binary that reads from a local or remote secret store

If a secret already exists as an environment variable or in a local JSON file, prefer `env` or `file` providers instead.

## SecretRef shape

```json5
{ source: "exec", provider: "vault", id: "providers/openai/apiKey" }
```

Validation rules:

- `provider` must match `^[a-z][a-z0-9_-]{0,63}$`
- `id` must match `^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$`
- `id` must not contain `.` or `..` as slash-delimited segments

## Provider config

Define the backing command under `secrets.providers`:

```json5
{
  secrets: {
    providers: {
      vault: {
        source: "exec",
        command: "/usr/local/bin/openclaw-vault-resolver",
        args: ["--profile", "prod"],
        passEnv: ["PATH", "VAULT_ADDR"],
        timeoutMs: 5000,
        maxOutputBytes: 262144,
        jsonOnly: true,
      },
    },
    defaults: {
      exec: "vault",
    },
  },
}
```

Key behavior:

- `command` must be an absolute path and OpenClaw runs it directly, not through a shell.
- Child env is minimal by default. Pass only required variables with `passEnv`, or fixed values with `env`.
- `timeoutMs` bounds total execution time.
- `noOutputTimeoutMs` can fail a hung command that produces no output.
- `maxOutputBytes` caps stdout/stderr capture.
- `jsonOnly` defaults to `true`.

## Stdin and stdout contract

OpenClaw sends one JSON request on stdin:

```json
{ "protocolVersion": 1, "provider": "vault", "ids": ["providers/openai/apiKey"] }
```

By default, the resolver should write JSON to stdout:

```json
{ "protocolVersion": 1, "values": { "providers/openai/apiKey": "<openai-api-key>" } }
```

Optional per-id failures:

```json
{
  "protocolVersion": 1,
  "values": {},
  "errors": { "providers/openai/apiKey": { "message": "not found" } }
}
```

Notes:

- JSON responses must include every requested id in `values` or `errors`.
- With `jsonOnly: false`, a single-id request may return a plain string on stdout instead of a JSON object.
- Non-zero exit codes, missing ids, invalid JSON, timeouts, or empty/non-string results fail resolution.

## Path and symlink safety

OpenClaw validates the command path before running it.

- By default, the command path must resolve to a regular file and symlink paths are rejected.
- Set `allowSymlinkCommand: true` only when you need package-manager shim paths such as `/opt/homebrew/bin/op`.
- If you allow symlinks, pair it with `trustedDirs` so the resolved target must stay inside trusted directories.
- On Windows, if ACL verification is unavailable for the command path, resolution fails closed unless `allowInsecurePath: true` is set for a trusted path.

## Example patterns

### 1Password CLI

```json5
{
  secrets: {
    providers: {
      onepassword_openai: {
        source: "exec",
        command: "/opt/homebrew/bin/op",
        allowSymlinkCommand: true,
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
        apiKey: { source: "exec", provider: "onepassword_openai", id: "value" },
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
        allowSymlinkCommand: true,
        trustedDirs: ["/opt/homebrew"],
        args: ["-d", "--extract", '["providers"]["openai"]["apiKey"]', "/path/to/secrets.enc.json"],
        passEnv: ["SOPS_AGE_KEY_FILE"],
        jsonOnly: false,
      },
    },
  },
}
```

### Vault

```json5
{
  secrets: {
    providers: {
      vault_openai: {
        source: "exec",
        command: "/home/gateway-user/.local/bin/openclaw-vault-read", // user-owned wrapper around the Vault CLI
        args: ["kv", "get", "-field=apiKey", "secret/providers/openai"],
        passEnv: ["HOME", "VAULT_ADDR", "VAULT_TOKEN"],
        jsonOnly: false,
      },
    },
  },
  models: {
    providers: {
      openai: {
        apiKey: { source: "exec", provider: "vault_openai", id: "value" },
      },
    },
  },
}
```

On POSIX, `command` must be owned by the same user running OpenClaw. If your installed `vault` binary is root-owned, point `command` at a user-owned wrapper that calls Vault.

## Operations notes

- `openclaw secrets audit` skips exec checks by default. Use `openclaw secrets audit --allow-exec` to run exec providers during audit.
- `openclaw secrets apply --dry-run` also skips exec checks unless `--allow-exec` is set.
- Write-mode `openclaw secrets apply` rejects plans that include exec providers or exec SecretRefs unless `--allow-exec` is set.
- Runtime startup and `openclaw secrets reload` fail fast when an active exec-backed SecretRef cannot be resolved.

## Related docs

- [Secrets Management](/gateway/secrets)
- [Configuration Reference](/gateway/configuration-reference#secrets)
- [Secrets Apply Plan Contract](/gateway/secrets-plan-contract)
