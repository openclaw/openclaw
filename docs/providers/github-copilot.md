---
summary: "Use GitHub Copilot via the official Copilot CLI SDK"
read_when:
  - You want to use GitHub Copilot as a model provider
  - You need the Copilot CLI + SDK flow
---
# Github Copilot

## What is GitHub Copilot?

GitHub Copilot is GitHub's AI coding assistant. It provides access to Copilot
models for your GitHub account and plan. Clawdbot can use Copilot as a model
provider via the official Copilot CLI SDK.

## Use Copilot in Clawdbot

Clawdbot integrates with GitHub Copilot through the official Copilot CLI SDK.
This requires the Copilot CLI to be installed and authenticated on the gateway
host.

## CLI setup

```bash
copilot auth login
```

Then validate Copilot in Clawdbot:

```bash
clawdbot models auth login-github-copilot
```

### Optional flags

```bash
clawdbot models auth login-github-copilot --profile-id github-copilot:work
clawdbot models auth login-github-copilot --yes
```

## Set a default model

```bash
clawdbot models set github-copilot/gpt-4o
```

### Config snippet

```json5
{
  agents: { defaults: { model: { primary: "github-copilot/gpt-4o" } } }
}
```

## Notes

- Requires an interactive TTY; run it directly in a terminal.
- Copilot model availability depends on your plan; if a model is rejected, try
  another ID (for example `github-copilot/gpt-4.1`).
- Copilot CLI must stay available on the gateway host.
