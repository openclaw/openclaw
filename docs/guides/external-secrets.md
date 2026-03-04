---
title: "External Secret Managers"
summary: "Replace manual API key copy-pasting with external secret managers like Doppler, 1Password CLI, or HashiCorp Vault"
read_when:
  - Integrating an external secrets manager with OpenClaw
  - Replacing manual API key management with automated secret injection
  - Scaling OpenClaw deployments across multiple machines
---

# External secret managers

OpenClaw has a built-in secrets management layer (SecretRef with env, file, and exec providers) that eliminates hardcoded API keys from your config. This guide shows how to pair that layer with popular external secret managers for a zero-plaintext credential workflow.

If you have not used OpenClaw secrets before, start with the [Secrets Management](/gateway/secrets) guide and `openclaw secrets configure`.

## The problem

A fresh OpenClaw setup with multiple providers and channels means managing keys for Anthropic, OpenAI, Google, Telegram, Discord, and more. Without a secrets workflow, you end up:

- Hardcoding keys in `openclaw.json`
- Copy-pasting keys when spinning up new instances
- Risking broken agents from a single wrong paste
- Losing track of which keys are where after rotation

OpenClaw already solves this with `${VAR_NAME}` substitution and SecretRef objects. External secret managers add a centralized vault on top of that pattern.

## How it works

The general pattern is the same regardless of which tool you use:

1. Store real credential values in your external secret manager
2. Configure OpenClaw to read credentials from environment variables or SecretRef providers
3. Launch OpenClaw through the secret manager's CLI (or configure a SecretRef exec provider)

## Doppler

[Doppler](https://www.doppler.com/) injects secrets as environment variables before your process starts.

### Doppler Setup

1. Install the Doppler CLI and authenticate:

```bash
brew install dopplerhq/cli/doppler
doppler login
```

2. Create a Doppler project (for example `openclaw-system`) and add your keys:

```
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
GEMINI_API_KEY=...
DISCORD_BOT_TOKEN=MTQ...
TELEGRAM_BOT_TOKEN=123:abc...
OPENCLAW_GATEWAY_TOKEN=...
```

3. Reference environment variables in your `openclaw.json`:

```json5
{
  models: {
    providers: {
      anthropic: { apiKey: "${ANTHROPIC_API_KEY}" },
      openai: { apiKey: "${OPENAI_API_KEY}" },
    },
  },
  channels: {
    discord: { token: "${DISCORD_BOT_TOKEN}" },
    telegram: { botToken: "${TELEGRAM_BOT_TOKEN}" },
  },
  gateway: {
    auth: { token: "${OPENCLAW_GATEWAY_TOKEN}" },
  },
}
```

4. Start OpenClaw through Doppler:

```bash
doppler run -- openclaw gateway --port 18789
```

Doppler injects every secret as an env var before OpenClaw reads the config. No keys touch disk.

### macOS LaunchAgent

To start OpenClaw with Doppler on boot, create a wrapper script:

```bash
#!/usr/bin/env bash
# ~/.openclaw/start-with-doppler.sh

# Explicitly set PATH to include Homebrew and pnpm binary locations
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/share/pnpm:$PATH"
exec doppler run --project openclaw-system --config prd -- openclaw gateway --port 18789
```

Point your LaunchAgent plist at this script instead of calling `openclaw gateway` directly.

### Key rotation

Rotate a key once in the Doppler dashboard. Every instance using the same project picks up the new value on next Gateway restart (or `openclaw secrets reload` if using SecretRef).

## 1Password CLI

[1Password CLI](https://developer.1password.com/docs/cli/) (`op`) can inject secrets the same way.

### 1Password Setup

```bash
brew install 1password-cli
op signin
```

Start OpenClaw with 1Password injection:

```bash
op run --env-file=~/.openclaw/op.env -- openclaw gateway --port 18789
```

Where `~/.openclaw/op.env` contains references:

```
ANTHROPIC_API_KEY=op://Vault/OpenClaw/anthropic-key
OPENAI_API_KEY=op://Vault/OpenClaw/openai-key
```

Your `openclaw.json` uses the same `${VAR_NAME}` pattern shown above.

## HashiCorp Vault (CLI Direct)

For Vault, use OpenClaw's `exec` SecretRef provider to call the Vault CLI directly. This eliminates the need for a custom resolver script.

```json5
{
  secrets: {
    providers: {
      vault_openai: {
        source: "exec",
        command: "/opt/homebrew/bin/vault",
        allowSymlinkCommand: true, // Required for Homebrew symlinked binaries
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
        apiKey: { source: "exec", provider: "vault_openai", id: "value" },
      },
    },
  },
}
```

The exec provider uses protocol payloads on stdin/stdout. See [Configuration Reference](/gateway/configuration-reference#secret-providers-config) for the full exec contract.

## Infisical

[Infisical](https://infisical.com/) works identically to Doppler:

```bash
infisical run -- openclaw gateway --port 18789
```

Store keys in your Infisical project, reference them as `${VAR_NAME}` in config.

## Verifying your setup

After configuring any external provider, run the built-in audit:

```bash
# Check for plaintext secrets still in config
openclaw secrets audit --check

# Reload secrets without restarting the gateway
openclaw secrets reload
```

`secrets audit` flags any remaining hardcoded credentials. Aim for a clean `status: clean` output.

## Which approach to pick

| Approach                                                      | Best for                                     | Tradeoff                            |
| ------------------------------------------------------------- | -------------------------------------------- | ----------------------------------- |
| `${VAR_NAME}` + env injection (Doppler, 1Password, Infisical) | Most users, single-machine setups            | Requires wrapping the start command |
| SecretRef `env` provider                                      | Teams already using `.env` or shell profiles | Keys still live in a file on disk   |
| SecretRef `file` provider                                     | Deployments with a `secrets.json` payload    | File must be secured (chmod 600)    |
| SecretRef `exec` provider                                     | Vault, custom resolvers, advanced setups     | Requires a resolver script/binary   |

For most personal setups, env injection via Doppler or 1Password is the simplest path.

## Related docs

- [Secrets Management](/gateway/secrets) -- full SecretRef contract and runtime behavior
- [SecretRef Credential Surface](/reference/secretref-credential-surface) -- supported credential paths
- [CLI: secrets](/cli/secrets) -- audit, configure, apply, reload commands
- [Configuration Reference](/gateway/configuration-reference#secrets) -- provider config schema
- [Environment](/help/environment) -- env var precedence and sources
