---
summary: "Configure external secrets managers to keep API keys out of openclaw.json"
read_when:
  - Setting up secrets management
  - Moving secrets out of plaintext config
title: "Secrets Manager"
---

# Secrets Manager

Keep API keys and tokens out of plaintext config whenever possible.

## Overview

By default, OpenClaw reads values directly from `openclaw.json`. That is simple, but storing
credentials in plaintext config is a security risk (especially on shared machines or in backups).

The secrets manager integration lets you reference external secrets with `$secret{NAME}`.
At config load time, OpenClaw resolves those references using a configured provider.

This is backward compatible: if you do **not** configure a `secrets` block, behavior is unchanged.

## Quick Start

### 1) Use `env` provider for local testing

```json5
{
  secrets: { provider: "env" },
  models: {
    providers: {
      openrouter: {
        apiKey: "$secret{OPENROUTER_API_KEY}",
      },
    },
  },
}
```

Set the variable before starting OpenClaw:

```bash
export OPENROUTER_API_KEY="sk-or-..."
openclaw gateway start
```

### 2) Switch to GCP Secret Manager for production

```json5
{
  secrets: {
    provider: "gcp",
    gcp: { project: "my-prod-project" },
  },
  gateway: {
    auth: {
      token: "$secret{OPENCLAW_GATEWAY_TOKEN}",
    },
  },
}
```

## Configuration

Full `secrets` config block:

```json5
{
  secrets: {
    provider: "gcp" | "env" | "keyring" | "aws" | "1password" | "doppler" | "bitwarden" | "vault",
    gcp: { project: "..." },          // required when provider is "gcp"
    aws: { region: "..." },
    doppler: { project: "...", config: "..." },
    vault: { address: "...", namespace: "...", mountPath: "..." },
    keyring: { keychainPath: "...", keychainPassword: "...", account: "..." },
  },
}
```

Only configure the provider block you use.

## Syntax

- `$secret{NAME}`: resolves to the secret value
- `$$secret{NAME}`: escapes to literal `$secret{NAME}`
- **Valid secret names:** alphanumeric characters, hyphens, underscores, and dots (`[a-zA-Z0-9_.-]+`). Examples: `my-api-key`, `slack.bot.token`, `DB_PASSWORD_v2`
- Works in any string value in config
- Resolution happens **after** `${ENV_VAR}` substitution
  - This means you can use env vars inside `secrets` provider settings
- The `secrets` block itself is **not** secret-resolved (prevents circular dependencies)

## Provider Guides

### Environment Variables (`env`)

Best for local testing, CI/CD, and Docker-based deployments.

```json5
{
  secrets: { provider: "env" },
  channels: {
    telegram: {
      botToken: "$secret{TELEGRAM_BOT_TOKEN}",
    },
  },
}
```

Set environment variables:

```bash
export TELEGRAM_BOT_TOKEN="123456:ABC..."
export OPENROUTER_API_KEY="sk-or-..."
```

In CI/Docker, set them using your platform’s secret/env settings.

### GCP Secret Manager (`gcp`)

Prerequisites:

- Install dependency: `pnpm add @google-cloud/secret-manager`
- Configure ADC (Application Default Credentials)
- Set `project` in config (required — Secret Manager doesn't support automatic project discovery)

Create a secret:

```bash
gcloud secrets create NAME --data-file=-
```

Then paste/pipe the secret value when prompted.

Example config:

```json5
{
  secrets: {
    provider: "gcp",
    gcp: { project: "my-project-id" },
  },
  models: {
    providers: {
      openai: {
        apiKey: "$secret{OPENAI_API_KEY}",
      },
    },
  },
}
```

How ADC works:

- Local development: typically uses your user credentials from `gcloud auth application-default login`
- Containers/servers: typically uses attached service account credentials

### OS Keyring (`keyring`)

#### macOS

Uses the `security` CLI with a dedicated OpenClaw keychain.

Create keychain:

```bash
security create-keychain -p '' ~/Library/Keychains/openclaw.keychain-db
```

Add secret:

```bash
security add-generic-password -a openclaw -s NAME -w "VALUE" ~/Library/Keychains/openclaw.keychain-db
```

Example config:

```json5
{
  secrets: {
    provider: "keyring",
    keyring: {
      keychainPath: "~/Library/Keychains/openclaw.keychain-db",
      keychainPassword: "",
      account: "openclaw",
    },
  },
}
```

#### Linux

Uses `secret-tool` (libsecret / D-Bus Secret Service).

Install libsecret tools:

```bash
# Arch
sudo pacman -S libsecret

# Debian/Ubuntu
sudo apt install libsecret-tools

# Fedora
sudo dnf install libsecret
```

Add secret:

```bash
echo -n "VALUE" | secret-tool store --label="openclaw: NAME" service openclaw key NAME
```

Example config:

```json5
{
  secrets: {
    provider: "keyring",
  },
}
```

#### Windows

Not yet supported.

### Coming Soon

The following providers are recognized in config but **not yet implemented**:

- AWS Secrets Manager (`aws`)
- 1Password (`1password`)
- Doppler (`doppler`)
- Bitwarden (`bitwarden`)
- HashiCorp Vault (`vault`)

**Behavior when configured:**

- If your config has `$secret{...}` references → startup **fails immediately** with a clear
  error telling you the provider isn't available yet and listing supported alternatives.
- If your config has **no** `$secret{...}` references → startup **succeeds with a warning**
  in the logs, so you're aware the provider won't work when you add secret references later.

This means you can safely prepare your config for a future provider switch without breaking
your current setup — just don't add `$secret{...}` references until the provider is implemented.

Contributions are welcome — see the stub files in `src/config/secrets/`.

## Sync vs Async

`$secret{...}` resolution requires async config loading.

The Gateway handles this automatically during normal startup. If secret references are detected in a sync-only load path, OpenClaw throws a clear error instead of silently continuing.

## Error Diagnostics

When `$secret{...}` references remain unresolved (e.g. sync load path), error messages include
the full config path where each reference was found:

```
Unresolved secret references: $secret{OPENAI_KEY} at models.providers.openai.apiKey
```

This helps you quickly locate which config field needs attention, especially in large configs
with multiple secret references.

## Troubleshooting

- `GCP secrets provider requires 'gcp.project' to be set`
  - Add `gcp: { project: "your-project-id" }` to your `secrets` config block
- `Failed to load @google-cloud/secret-manager`
  - Install the dependency in your OpenClaw environment:
    - `pnpm add @google-cloud/secret-manager`
- `secret-tool not found`
  - Install libsecret tools (`libsecret-tools` on Debian/Ubuntu)
- `Secret not found in keychain`
  - Add it with the keychain CLI commands above and verify `NAME` matches exactly
- `Config contains $secret{...} references but secrets can only be resolved in async mode`
  - Start the gateway normally (`openclaw gateway start`) so async config loading is used
