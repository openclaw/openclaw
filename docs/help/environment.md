---
summary: "Where OpenClaw loads environment variables and the precedence order"
read_when:
  - You need to know which env vars are loaded, and in what order
  - You are debugging missing API keys in the Gateway
  - You are documenting provider auth or deployment environments
title: "Environment Variables"
---

# Environment variables

OpenClaw pulls environment variables from multiple sources. The rule is **never override existing values**.

## Precedence (highest → lowest)

1. **Process environment** (what the Gateway process already has from the parent shell/daemon).
2. **`.env` in the current working directory** (dotenv default; does not override).
3. **Global `.env`** at `~/.openclaw/.env` (aka `$OPENCLAW_STATE_DIR/.env`; does not override).
4. **Config `env` block** in `~/.openclaw/openclaw.json` (applied only if missing).
5. **Optional login-shell import** (`env.shellEnv.enabled` or `OPENCLAW_LOAD_SHELL_ENV=1`), applied only for missing expected keys.

On Ubuntu fresh installs that use the default state dir, OpenClaw also treats `~/.config/openclaw/gateway.env` as a compatibility fallback after the global `.env`. If both files exist and disagree, OpenClaw keeps `~/.openclaw/.env` and prints a warning.

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

- `OPENCLAW_LOAD_SHELL_ENV=1`
- `OPENCLAW_SHELL_ENV_TIMEOUT_MS=15000`

## Runtime-injected env vars

OpenClaw also injects context markers into spawned child processes:

- `OPENCLAW_SHELL=exec`: set for commands run through the `exec` tool.
- `OPENCLAW_SHELL=acp`: set for ACP runtime backend process spawns (for example `acpx`).
- `OPENCLAW_SHELL=acp-client`: set for `openclaw acp client` when it spawns the ACP bridge process.
- `OPENCLAW_SHELL=tui-local`: set for local TUI `!` shell commands.

These are runtime markers (not required user config). They can be used in shell/profile logic
to apply context-specific rules.

## UI env vars

- `OPENCLAW_THEME=light`: force the light TUI palette when your terminal has a light background.
- `OPENCLAW_THEME=dark`: force the dark TUI palette.
- `COLORFGBG`: if your terminal exports it, OpenClaw uses the background color hint to auto-pick the TUI palette.

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

See [Configuration: Env var substitution](/gateway/configuration-reference#env-var-substitution) for full details.

## Secret refs vs `${ENV}` strings

OpenClaw supports two env-driven patterns:

- `${VAR}` string substitution in config values.
- SecretRef objects (`{ source: "env", provider: "default", id: "VAR" }`) for fields that support secrets references.

Both resolve from process env at activation time. SecretRef details are documented in [Secrets Management](/gateway/secrets).

## Path-related env vars

| Variable               | Purpose                                                                                                                                                                          |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OPENCLAW_HOME`        | Override the home directory used for all internal path resolution (`~/.openclaw/`, agent dirs, sessions, credentials). Useful when running OpenClaw as a dedicated service user. |
| `OPENCLAW_STATE_DIR`   | Override the state directory (default `~/.openclaw`).                                                                                                                            |
| `OPENCLAW_CONFIG_PATH` | Override the config file path (default `~/.openclaw/openclaw.json`).                                                                                                             |

## Logging

| Variable             | Purpose                                                                                                                                                                                      |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OPENCLAW_LOG_LEVEL` | Override log level for both file and console (e.g. `debug`, `trace`). Takes precedence over `logging.level` and `logging.consoleLevel` in config. Invalid values are ignored with a warning. |

### `OPENCLAW_HOME`

When set, `OPENCLAW_HOME` replaces the system home directory (`$HOME` / `os.homedir()`) for all internal path resolution. This enables full filesystem isolation for headless service accounts.

**Precedence:** `OPENCLAW_HOME` > `$HOME` > `USERPROFILE` > `os.homedir()`

**Example** (macOS LaunchDaemon):

```xml
<key>EnvironmentVariables</key>
<dict>
  <key>OPENCLAW_HOME</key>
  <string>/Users/user</string>
</dict>
```

`OPENCLAW_HOME` can also be set to a tilde path (e.g. `~/svc`), which gets expanded using `$HOME` before use.

## nvm users: web_fetch TLS failures

If Node.js was installed via **nvm** (not the system package manager), the built-in `fetch()` uses
nvm's bundled CA store, which may be missing modern root CAs (ISRG Root X1/X2 for Let's Encrypt,
DigiCert Global Root G2, etc.). This causes `web_fetch` to fail with `"fetch failed"` on most HTTPS sites.

On Linux, OpenClaw automatically detects nvm and applies the fix in the actual startup environment:

- `openclaw gateway install` writes `NODE_EXTRA_CA_CERTS` into the systemd service environment
- the `openclaw` CLI entrypoint re-execs itself with `NODE_EXTRA_CA_CERTS` set before Node startup

**Manual fix (for older versions or direct `node ...` launches):**

Export the variable before starting OpenClaw:

```bash
export NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt
openclaw gateway run
```

Do not rely on writing only to `~/.openclaw/.env` for this variable; Node reads
`NODE_EXTRA_CA_CERTS` at process startup.

## Common Environment Variables

### Provider API Keys

These are the most commonly used environment variables for model providers:

| Variable | Description | Example |
|----------|-------------|---------|
| `OPENAI_API_KEY` | OpenAI API key | `sk-...` |
| `ANTHROPIC_API_KEY` | Anthropic API key | `sk-ant-api...` |
| `GROQ_API_KEY` | Groq API key | `gsk-...` |
| `MISTRAL_API_KEY` | Mistral API key | `mistral-...` |
| `GOOGLE_API_KEY` | Google AI Studio API key | `AIza...` |
| `DEEPGRAM_API_KEY` | Deepgram API key (for speech) | `d7...` |
| `OPENROUTER_API_KEY` | OpenRouter API key | `sk-or-...` |

### Gateway Configuration

| Variable | Description | Example |
|----------|-------------|---------|
| `OPENCLAW_GATEWAY_TOKEN` | Gateway authentication token | `claw_...` |
| `OPENCLAW_GATEWAY_BIND` | Gateway binding mode | `lan` |
| `OPENCLAW_GATEWAY_MODE` | Gateway mode | `local` |
| `OPENCLAW_CONTROL_UI_ALLOWED_ORIGINS` | CORS origins for Control UI | `http://localhost:18789` |

### Runtime Configuration

| Variable | Description | Example |
|----------|-------------|---------|
| `NODE_ENV` | Node.js environment | `production` |
| `OPENCLAW_LOG_LEVEL` | Log level | `info` |
| `OPENCLAW_LOAD_SHELL_ENV` | Load shell environment | `1` |
| `OPENCLAW_THEME` | TUI theme | `dark` |

## Environment Variable Best Practices

### Production Deployments

1. **Use a secrets manager** — For production, use a proper secrets manager instead of .env files
2. **Limit access** — Restrict access to environment variables containing secrets
3. **Rotate keys** — Regularly rotate API keys and tokens
4. **Use specific keys** — Only set the environment variables you actually need
5. **Document your setup** — Keep track of which variables are used in each environment

### Development Environments

1. **Use .env files** — Store development variables in a .env file
2. **Ignore .env in git** — Add .env to .gitignore to avoid committing secrets
3. **Use .env.example** — Provide a template with placeholder values
4. **Separate environments** — Use different .env files for development, testing, and production

### Docker Deployments

For Docker deployments, you can set environment variables in several ways:

1. **Docker Compose file**:
   ```yaml
   services:
     openclaw-gateway:
       environment:
         - OPENAI_API_KEY=sk-...
         - OPENCLAW_LOG_LEVEL=info
   ```

2. **Environment file**:
   ```bash
   # .env
   OPENAI_API_KEY=sk-...
   OPENCLAW_LOG_LEVEL=info
   ```
   ```yaml
   services:
     openclaw-gateway:
       env_file:
         - .env
   ```

3. **Docker run command**:
   ```bash
   docker run -e OPENAI_API_KEY=sk-... openclaw/openclaw
   ```

## Troubleshooting Environment Variables

### Common Issues

1. **Variables not being loaded** — Check the precedence order and ensure variables are set in the correct location
2. **Secrets not working** — Verify that secret references are correctly formatted
3. **Permission issues** — Ensure .env files have proper permissions (e.g., 600 on Linux)
4. **nvm TLS issues** — See the section above about NODE_EXTRA_CA_CERTS

### Debugging Tips

1. **Check current environment**:
   ```bash
   openclaw doctor --env
   ```

2. **Verify variable substitution**:
   ```bash
   openclaw config get --path "models.providers.openai.apiKey"
   ```

3. **Test with a simple script**:
   ```bash
   node -e "console.log(process.env.OPENAI_API_KEY ? 'Set' : 'Not set')"
   ```

## Related

- [Gateway configuration](/gateway/configuration)
- [FAQ: env vars and .env loading](/help/faq#env-vars-and-env-loading)
- [Models overview](/concepts/models)
- [Secrets Management](/gateway/secrets)
