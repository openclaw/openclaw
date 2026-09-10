---
summary: "Env var sources and precedence, inline env config, shell env import, substitution, and secret refs"
title: "Environment variables"
sidebarTitle: "Environment variables"
read_when:
  - Deciding where an API key should live
  - Using ${VAR} substitution inside config values
  - Pointing a config field at a secret ref
---

## Environment variables

OpenClaw reads env vars from the parent process plus:

- `.env` from the current working directory (if present)
- `~/.openclaw/.env` (global fallback)

Neither file overrides existing env vars. You can also set inline env vars in config:

```json5
{
  env: {
    vars: {
      OPENROUTER_API_KEY: "sk-or-...",
      GROQ_API_KEY: "gsk-...",
    },
  },
}
```

<Accordion title="Shell env import (optional)">
  If enabled and expected keys aren't set, OpenClaw runs your login shell and imports only the missing keys:

```json5
{
  env: {
    shellEnv: { enabled: true, timeoutMs: 15000 },
  },
}
```

Env var equivalent: `OPENCLAW_LOAD_SHELL_ENV=1`. Default `timeoutMs`: `15000`.
</Accordion>

<Accordion title="Env var substitution in config values">
  Reference env vars in any config string value with `${VAR_NAME}`:

```json5
{
  gateway: { auth: { token: "${OPENCLAW_GATEWAY_TOKEN}" } },
  models: { providers: { custom: { apiKey: "${CUSTOM_API_KEY}" } } },
}
```

Rules:

- Only uppercase names matched: `[A-Z_][A-Z0-9_]*`
- Missing/empty vars stay visibly unresolved, emit a warning, and are unavailable to consumers that require the value
- Escape with `$${VAR}` to produce a literal `${VAR}` value
- Works inside `$include` files
- Inline substitution: `"${BASE}/v1"` → `"https://api.example.com/v1"`

</Accordion>

<Accordion title="Secret refs (env, file, exec, store)">
  For fields that support SecretRef objects, you can use:

```json5
{
  models: {
    providers: {
      openai: { apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" } },
    },
  },
  skills: {
    entries: {
      "image-lab": {
        apiKey: {
          source: "file",
          provider: "filemain",
          id: "/skills/entries/image-lab/apiKey",
        },
      },
    },
  },
  channels: {
    googlechat: {
      serviceAccount: {
        source: "exec",
        provider: "vault",
        id: "channels/googlechat/serviceAccount",
      },
    },
  },
}
```

The `env` ref above uses the built-in `default` provider and needs no `secrets.providers.default` entry unless `secrets.defaults.env` selects another alias. The same rule applies to `store` refs and `secrets.defaults.store`. See [Secrets Management](/gateway/secrets#secretref-contract) for provider precedence and the required `file`/`exec` provider configuration.
Supported credential paths are listed in [SecretRef Credential Surface](/reference/secretref-credential-surface).
</Accordion>

See [Environment](/help/environment) for full precedence and sources.
