# OpenAI Codex CLI Auth (OpenClaw plugin)

Use OpenAI models with your **ChatGPT Plus/Pro subscription** via the Codex CLI OAuth tokens.

This plugin reads authentication from the [OpenAI Codex CLI](https://github.com/openai/codex) and uses those OAuth credentials to access OpenAI models — no separate API key required.

## Enable

Bundled plugins are disabled by default. Enable this one:

```bash
openclaw plugins enable openai-codex-auth
```

Restart the Gateway after enabling.

## Prerequisites

1. **ChatGPT Plus or Pro subscription** — required for Codex CLI access
2. **Codex CLI installed and authenticated**:

```bash
# Install Codex CLI
npm install -g @openai/codex

# Authenticate (opens browser for OAuth)
codex login
```

This creates `~/.codex/auth.json` with your OAuth tokens.

## Authenticate with OpenClaw

After Codex CLI is authenticated:

```bash
openclaw models auth login --provider openai-codex --set-default
```

## Available Models

The following models are available through Codex CLI authentication:

- `openai/gpt-4.1`, `openai/gpt-4.1-mini`, `openai/gpt-4.1-nano`
- `openai/gpt-4o`, `openai/gpt-4o-mini`
- `openai/o1`, `openai/o1-mini`, `openai/o1-pro`
- `openai/o3`, `openai/o3-mini`
- `openai/o4-mini`

Default model: `openai/o3`

## How It Works

1. The plugin reads `~/.codex/auth.json` created by `codex login`
2. OAuth tokens from your ChatGPT subscription are extracted
3. OpenClaw uses these tokens to authenticate with OpenAI's API
4. Tokens auto-refresh when needed (handled by OpenClaw's credential system)

## Why Use This?

- **No separate API key** — use your existing ChatGPT Plus/Pro subscription
- **No usage-based billing** — covered by your subscription
- **Access to latest models** — same models available in ChatGPT

## Troubleshooting

### "No Codex auth found"

Run `codex login` to authenticate the Codex CLI first.

### Tokens expired

Re-run `codex login` to refresh your tokens, then re-authenticate:

```bash
codex login
openclaw models auth login --provider openai-codex --set-default
```

### Model not available

Some models may require specific subscription tiers (e.g., o1-pro requires ChatGPT Pro).
