---
summary: "Contract for `secrets apply` plans: target validation, path matching, and `auth-profiles.json` target scope"
read_when:
  - Generating or reviewing `openclaw secrets apply` plans
  - Debugging `Invalid plan target path` errors
  - Understanding target type and path validation behavior
title: "Secrets apply plan contract"
---

This page defines the strict contract enforced by `openclaw secrets apply`.

If a target does not match these rules, apply fails before mutating configuration.

## Plan file shape

`openclaw secrets apply --from <plan.json>` expects a plan with a `targets` array and optional provider modifications:

```json5
{
  version: 1,
  protocolVersion: 1,
  // Optional: define new providers or override existing ones
  providerUpserts: {
    onepassword_anthropic: {
      source: "exec",
      command: "/usr/bin/op",
      args: ["read", "op://Vault/Anthropic/credential"],
      passEnv: ["HOME", "OP_SERVICE_ACCOUNT_TOKEN"],
      jsonOnly: false,
      allowInsecurePath: true,
    },
  },
  // Optional: remove providers
  providerDeletes: ["legacy_provider_1"],
  // Required: credential targets
  targets: [
    {
      type: "models.providers.apiKey",
      path: "models.providers.openai.apiKey",
      pathSegments: ["models", "providers", "openai", "apiKey"],
      providerId: "openai",
      ref: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
    },
    {
      type: "auth-profiles.api_key.key",
      path: "profiles.openai:default.key",
      pathSegments: ["profiles", "openai:default", "key"],
      agentId: "main",
      ref: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
    },
  ],
}
```

## Provider upserts and deletes

A plan can optionally include `providerUpserts` (object) and `providerDeletes` (array) at the
top level. These let a single plan define new exec/file/env providers in `secrets.providers`
and remove existing ones, in addition to writing credential targets.

Provider modifications are useful for atomic migrations where you need to define a provider
and then immediately reference it in targets — all in one plan.

### `providerUpserts`

Object keyed by provider alias. Each value is the full provider configuration (same shape
accepted by `secrets.providers.<alias>` in `openclaw.json`):

```json5
{
  providerUpserts: {
    onepassword_anthropic: {
      source: "exec",
      command: "/usr/bin/op",
      args: ["read", "op://Vault/Anthropic/credential"],
      passEnv: ["HOME", "OP_SERVICE_ACCOUNT_TOKEN"],
      jsonOnly: false,
      allowInsecurePath: true,
    },
    bitwarden_claude: {
      source: "exec",
      command: "/usr/bin/bw",
      args: ["get", "password", "openclaw-claude"],
      passEnv: ["HOME", "BW_SESSION"],
      jsonOnly: false,
    },
  },
}
```

**Rules:**

- Aliases must match alphanumeric, underscore, and hyphen characters (no dots, spaces, or
  special chars).
- Each provider's shape must be valid for its `source` (see [Secrets Management](/gateway/secrets)
  for provider format details).
- `providerUpserts` are applied **before** targets are resolved, so a single plan can both
  define a provider and reference it in targets.
- Upserts can override existing providers with the same alias.

### `providerDeletes`

Array of provider aliases to remove from `secrets.providers`:

```json5
{
  providerDeletes: ["legacy_provider_1", "legacy_provider_2"],
}
```

**Rules:**

- Deletes run **after** targets and after upserts are processed.
- A plan that deletes a provider whose alias is still referenced by an active target will
  refuse to apply with a validation error.
- Only providers listed in `providerDeletes` are removed; all others remain.

### Apply-time summary

The CLI logs a summary of all operations when applying:

```text
Plan: targets=4, providerUpserts=2, providerDeletes=0.
```

Use `--dry-run` to preview the plan without writing:

```bash
openclaw secrets apply --from /tmp/plan.json --dry-run
```

## Use case: End-to-end provider migration

A common workflow is migrating from plaintext credentials to an external provider (e.g.,
1Password) while updating all credential references in one atomic operation.

This plan:

1. Defines a new 1Password exec provider (`providerUpserts`)
2. Updates all credential targets to reference that provider
3. (Optionally) removes the old plaintext provider (`providerDeletes`)

```json5
{
  version: 1,
  protocolVersion: 1,
  providerUpserts: {
    // Define the 1Password exec provider
    onepassword_migration: {
      source: "exec",
      command: "/usr/bin/op",
      args: ["read", "op://OpenClaw/API_Keys/credential"],
      passEnv: ["HOME", "OP_SERVICE_ACCOUNT_TOKEN"],
      jsonOnly: false,
      allowInsecurePath: true,
    },
  },
  providerDeletes: ["plaintext"],
  targets: [
    // Update Anthropic credential target
    {
      type: "models.providers.apiKey",
      path: "models.providers.anthropic.apiKey",
      pathSegments: ["models", "providers", "anthropic", "apiKey"],
      providerId: "anthropic",
      ref: { source: "exec", provider: "onepassword_migration", id: "anthropic-key" },
    },
    // Update auth profile target
    {
      type: "auth-profiles.api_key.key",
      path: "profiles.anthropic:default.key",
      pathSegments: ["profiles", "anthropic:default", "key"],
      agentId: "main",
      authProfileProvider: "anthropic",
      ref: { source: "exec", provider: "onepassword_migration", id: "anthropic-key" },
    },
  ],
}
```

## Supported target scope

Plan targets are accepted for supported credential paths in:

- [SecretRef Credential Surface](/reference/secretref-credential-surface)

## Target type behavior

General rule:

- `target.type` must be recognized and must match the normalized `target.path` shape.

Compatibility aliases remain accepted for existing plans:

- `models.providers.apiKey`
- `skills.entries.apiKey`
- `channels.googlechat.serviceAccount`

## Path validation rules

Each target is validated with all of the following:

- `type` must be a recognized target type.
- `path` must be a non-empty dot path.
- `pathSegments` can be omitted. If provided, it must normalize to exactly the same path as `path`.
- Forbidden segments are rejected: `__proto__`, `prototype`, `constructor`.
- The normalized path must match the registered path shape for the target type.
- If `providerId` or `accountId` is set, it must match the id encoded in the path.
- `auth-profiles.json` targets require `agentId`.
- When creating a new `auth-profiles.json` mapping, include `authProfileProvider`.

## Failure behavior

If a target fails validation, apply exits with an error like:

```text
Invalid plan target path for models.providers.apiKey: models.providers.openai.baseUrl
```

No writes are committed for an invalid plan.

## Exec provider consent behavior

- `--dry-run` skips exec SecretRef checks by default.
- Plans containing exec SecretRefs/providers are rejected in write mode unless `--allow-exec` is set.
- When validating/applying exec-containing plans, pass `--allow-exec` in both dry-run and write commands.

## Runtime and audit scope notes

- Ref-only `auth-profiles.json` entries (`keyRef`/`tokenRef`) are included in runtime resolution and audit coverage.
- `secrets apply` writes supported `openclaw.json` targets, supported `auth-profiles.json`
  targets, and optional scrub targets.

## Operator checks

```bash
# Validate plan without writes
openclaw secrets apply --from /tmp/openclaw-secrets-plan.json --dry-run

# Then apply for real
openclaw secrets apply --from /tmp/openclaw-secrets-plan.json

# For exec-containing plans, opt in explicitly in both modes
openclaw secrets apply --from /tmp/openclaw-secrets-plan.json --dry-run --allow-exec
openclaw secrets apply --from /tmp/openclaw-secrets-plan.json --allow-exec
```

If apply fails with an invalid target path message, regenerate the plan with
`openclaw secrets configure` or fix the target path to a supported shape above.

## Related docs

- [Secrets Management](/gateway/secrets)
- [CLI `secrets`](/cli/secrets)
- [SecretRef Credential Surface](/reference/secretref-credential-surface)
- [Configuration Reference](/gateway/configuration-reference)
