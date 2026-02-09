---
summary: "Where EasyHub loads environment variables and the precedence order"
read_when:
  - You need to know which env vars are loaded, and in what order
  - You are debugging missing API keys in the Gateway
  - You are documenting provider auth or deployment environments
title: "Environment Variables"
---

# Environment variables

EasyHub pulls environment variables from multiple sources. The rule is **never override existing values**.

## Precedence (highest → lowest)

1. **Process environment** (what the Gateway process already has from the parent shell/daemon).
2. **`.env` in the current working directory** (dotenv default; does not override).
3. **Global `.env`** at `~/.easyhub/.env` (aka `$EASYHUB_STATE_DIR/.env`; does not override).
4. **Config `env` block** in `~/.easyhub/easyhub.json` (applied only if missing).
5. **Optional login-shell import** (`env.shellEnv.enabled` or `EASYHUB_LOAD_SHELL_ENV=1`), applied only for missing expected keys.

If the config file is missing entirely, step 4 is skipped; shell import still runs if enabled.

## Config `env` block

Two equivalent ways to set inline env vars (both are non-overriding):

```json5
{
  env: {
    OPENROUTER_API_KEY: "sk-or-...",
    vars: {
      GROQ_API_KEY: "gsk-...",
    },
  },
}
```

## Shell env import

`env.shellEnv` runs your login shell and imports only **missing** expected keys:

```json5
{
  env: {
    shellEnv: {
      enabled: true,
      timeoutMs: 15000,
    },
  },
}
```

Env var equivalents:

- `EASYHUB_LOAD_SHELL_ENV=1`
- `EASYHUB_SHELL_ENV_TIMEOUT_MS=15000`

## Env var substitution in config

You can reference env vars directly in config string values using `${VAR_NAME}` syntax:

```json5
{
  models: {
    providers: {
      "vercel-gateway": {
        apiKey: "${VERCEL_GATEWAY_API_KEY}",
      },
    },
  },
}
```

See [Configuration: Env var substitution](/gateway/configuration#env-var-substitution-in-config) for full details.

## Path-related env vars

| Variable               | Purpose                                                                                                                                                                          |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EASYHUB_HOME`        | Override the home directory used for all internal path resolution (`~/.easyhub/`, agent dirs, sessions, credentials). Useful when running EasyHub as a dedicated service user. |
| `EASYHUB_STATE_DIR`   | Override the state directory (default `~/.easyhub`).                                                                                                                            |
| `EASYHUB_CONFIG_PATH` | Override the config file path (default `~/.easyhub/easyhub.json`).                                                                                                             |

### `EASYHUB_HOME`

When set, `EASYHUB_HOME` replaces the system home directory (`$HOME` / `os.homedir()`) for all internal path resolution. This enables full filesystem isolation for headless service accounts.

**Precedence:** `EASYHUB_HOME` > `$HOME` > `USERPROFILE` > `os.homedir()`

**Example** (macOS LaunchDaemon):

```xml
<key>EnvironmentVariables</key>
<dict>
  <key>EASYHUB_HOME</key>
  <string>/Users/kira</string>
</dict>
```

`EASYHUB_HOME` can also be set to a tilde path (e.g. `~/svc`), which gets expanded using `$HOME` before use.

## Related

- [Gateway configuration](/gateway/configuration)
- [FAQ: env vars and .env loading](/help/faq#env-vars-and-env-loading)
- [Models overview](/concepts/models)
