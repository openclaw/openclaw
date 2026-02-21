---
summary: "Current secret reference support in config values"
read_when:
  - Migrating API keys/tokens out of openclaw.json
  - Validating supported config substitution syntax
title: "Secrets in config values"
---

# Secrets in config values

Use environment-variable substitution in config values instead of hardcoding plaintext secrets in `openclaw.json`.

## What is supported today

OpenClaw currently supports **environment variable substitution** using:

- `${VAR_NAME}`

Example:

```json5
{
  models: {
    providers: {
      openai: {
        apiKey: "${OPENAI_API_KEY}",
      },
    },
  },
}
```

Rules:

- Variable names must match: `[A-Z_][A-Z0-9_]*`
- Missing or empty values fail fast during config load
- Escape literal output with `$${VAR_NAME}`

## Migration playbook (plaintext → env refs)

1. **Inventory secret fields**
   - `apiKey`, `token`, `password`, webhook secrets, etc.
2. **Create env vars in runtime**
   - Shell profile, launchd/systemd env, or deployment environment.
3. **Replace plaintext config values**
   - Example: `"sk-..."` → `"${OPENAI_API_KEY}"`
4. **Restart and validate**
   - `openclaw gateway restart`
   - `openclaw gateway status`
5. **Rotate old plaintext-exposed keys**
   - Treat previously committed plaintext keys as compromised.

## Troubleshooting

### Missing env var / unresolved reference

- Confirm the variable is present in the process runtime (not only your interactive shell).
- Verify service env source (launchd/systemd/container env).

### Value is empty

- Empty values are treated as invalid and fail config load.
- Confirm your secret loader/export path is correct before restart.

## Security notes

- Never paste real secrets into docs, issues, or chat logs.
- Use least-privilege scopes for tokens/keys.
- Separate dev/staging/prod secrets.

## Roadmap note

Provider-specific secret backends (for example keyring/1Password/cloud secret managers) are being tracked upstream, but are **not documented here as current behavior** until they are merged and released.

---

Related:

- [Gateway Configuration](/gateway/configuration)
- [Environment](/help/environment)
