---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Where OpenClaw loads environment variables and the precedence order"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You need to know which env vars are loaded, and in what order（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You are debugging missing API keys in the Gateway（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You are documenting provider auth or deployment environments（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Environment Variables"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Environment variables（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw pulls environment variables from multiple sources. The rule is **never override existing values**.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Precedence (highest → lowest)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. **Process environment** (what the Gateway process already has from the parent shell/daemon).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. **`.env` in the current working directory** (dotenv default; does not override).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. **Global `.env`** at `~/.openclaw/.env` (aka `$OPENCLAW_STATE_DIR/.env`; does not override).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. **Config `env` block** in `~/.openclaw/openclaw.json` (applied only if missing).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
5. **Optional login-shell import** (`env.shellEnv.enabled` or `OPENCLAW_LOAD_SHELL_ENV=1`), applied only for missing expected keys.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If the config file is missing entirely, step 4 is skipped; shell import still runs if enabled.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Config `env` block（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Two equivalent ways to set inline env vars (both are non-overriding):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  env: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    OPENROUTER_API_KEY: "sk-or-...",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    vars: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      GROQ_API_KEY: "gsk-...",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Shell env import（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`env.shellEnv` runs your login shell and imports only **missing** expected keys:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  env: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    shellEnv: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      enabled: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      timeoutMs: 15000,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Env var equivalents:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `OPENCLAW_LOAD_SHELL_ENV=1`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `OPENCLAW_SHELL_ENV_TIMEOUT_MS=15000`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Env var substitution in config（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
You can reference env vars directly in config string values using `${VAR_NAME}` syntax:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  models: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    providers: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "vercel-gateway": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        apiKey: "${VERCEL_GATEWAY_API_KEY}",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
See [Configuration: Env var substitution](/gateway/configuration#env-var-substitution-in-config) for full details.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Path-related env vars（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Variable               | Purpose                                                                                                                                                                          |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `OPENCLAW_HOME`        | Override the home directory used for all internal path resolution (`~/.openclaw/`, agent dirs, sessions, credentials). Useful when running OpenClaw as a dedicated service user. |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `OPENCLAW_STATE_DIR`   | Override the state directory (default `~/.openclaw`).                                                                                                                            |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `OPENCLAW_CONFIG_PATH` | Override the config file path (default `~/.openclaw/openclaw.json`).                                                                                                             |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### `OPENCLAW_HOME`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When set, `OPENCLAW_HOME` replaces the system home directory (`$HOME` / `os.homedir()`) for all internal path resolution. This enables full filesystem isolation for headless service accounts.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Precedence:** `OPENCLAW_HOME` > `$HOME` > `USERPROFILE` > `os.homedir()`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Example** (macOS LaunchDaemon):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```xml（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<key>EnvironmentVariables</key>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<dict>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <key>OPENCLAW_HOME</key>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <string>/Users/kira</string>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
</dict>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`OPENCLAW_HOME` can also be set to a tilde path (e.g. `~/svc`), which gets expanded using `$HOME` before use.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Related（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Gateway configuration](/gateway/configuration)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [FAQ: env vars and .env loading](/help/faq#env-vars-and-env-loading)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Models overview](/concepts/models)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
