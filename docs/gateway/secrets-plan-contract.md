---
summary: "Contract for `secrets apply` plans: allowed target paths, validation, and ref-only auth-profile behavior"
read_when:
  - Generating or reviewing `openclaw secrets apply` plan files
  - Debugging `Invalid plan target path` errors
  - Understanding how `keyRef` and `tokenRef` influence implicit provider discovery
title: "Secrets Apply Plan Contract"
---

# Secrets apply plan contract

This page defines the strict contract enforced by `openclaw secrets apply`.

If a target does not match these rules, apply fails before mutating config.

## Plan file shape

`openclaw secrets apply --from <plan.json>` expects a `targets` array of plan targets:

```json5
{
  version: 1,
  protocolVersion: 1,
  targets: [
    {
      type: "models.providers.apiKey",
      path: "models.providers.openai.apiKey",
      pathSegments: ["models", "providers", "openai", "apiKey"],
      providerId: "openai",
      ref: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
    },
  ],
}
```

## Allowed target types and paths

| `target.type`                        | Allowed `target.path` shape                               | Optional id match rule                              |
| ------------------------------------ | --------------------------------------------------------- | --------------------------------------------------- |
| `models.providers.apiKey`            | `models.providers.<providerId>.apiKey`                    | `providerId` must match `<providerId>` when present |
| `skills.entries.apiKey`              | `skills.entries.<skillKey>.apiKey`                        | n/a                                                 |
| `channels.googlechat.serviceAccount` | `channels.googlechat.serviceAccount`                      | `accountId` must be empty/omitted                   |
| `channels.googlechat.serviceAccount` | `channels.googlechat.accounts.<accountId>.serviceAccount` | `accountId` must match `<accountId>` when present   |

## Path validation rules

Each target is validated with all of the following:

- `type` must be one of the allowed target types above.
- `path` must be a non-empty dot path.
- `pathSegments` can be omitted. If provided, it must normalize to exactly the same path as `path`.
- Forbidden segments are rejected: `__proto__`, `prototype`, `constructor`.
- The normalized path must match one of the allowed path shapes for the target type.
- If `providerId` / `accountId` is set, it must match the id encoded in the path.

## Failure behavior

If a target fails validation, apply exits with an error like:

```text
Invalid plan target path for models.providers.apiKey: models.providers.openai.baseUrl
```

No partial mutation is committed for that invalid target path.

## Ref-only auth profiles and implicit providers

Implicit provider discovery also considers auth profiles that store refs instead of plaintext credentials:

- `type: "api_key"` profiles can use `keyRef` (for example env-backed refs).
- `type: "token"` profiles can use `tokenRef`.

Behavior:

- For API-key providers (for example `volcengine`, `byteplus`), ref-only profiles can still activate implicit provider entries.
- For `github-copilot`, if the profile has no plaintext token, discovery will try `tokenRef` env resolution before token exchange.

## Operator checks

```bash
# Validate plan without writes
openclaw secrets apply --from /tmp/openclaw-secrets-plan.json --dry-run

# Then apply for real
openclaw secrets apply --from /tmp/openclaw-secrets-plan.json
```

If apply fails with an invalid target path message, regenerate the plan with `openclaw secrets configure` or fix the target path to one of the allowed shapes above.

## Related docs

- [Secrets Management](/gateway/secrets)
- [CLI `secrets`](/cli/secrets)
- [Configuration Reference](/gateway/configuration-reference)
