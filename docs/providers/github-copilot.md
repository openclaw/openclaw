---
summary: "Sign in to GitHub Copilot from OpenClaw using the device flow"
read_when:
  - You want to use GitHub Copilot as a model provider
  - You need the `openclaw models auth login-github-copilot` flow
title: "GitHub Copilot"
---

# GitHub Copilot

## What is GitHub Copilot?

GitHub Copilot is GitHub's AI coding assistant. It provides access to Copilot
models for your GitHub account and plan. OpenClaw can use Copilot as a model
provider in two different ways.

## Two ways to use Copilot in OpenClaw

### 1) Built-in GitHub Copilot provider (`github-copilot`)

Use the native device-login flow to obtain a GitHub token, then exchange it for
Copilot API tokens when OpenClaw runs. This is the **default** and simplest path
because it does not require VS Code.

### 2) Copilot Proxy plugin (`copilot-proxy`)

Use the **Copilot Proxy** VS Code extension as a local bridge. OpenClaw talks to
the proxy’s `/v1` endpoint and uses the model list you configure there. Choose
this when you already run Copilot Proxy in VS Code or need to route through it.
You must enable the plugin and keep the VS Code extension running.

Use GitHub Copilot as a model provider (`github-copilot`). The login command runs
the GitHub device flow, saves an auth profile, and updates your config to use that
profile.

## CLI setup

```bash
openclaw models auth login-github-copilot
```

You'll be prompted to visit a URL and enter a one-time code. Keep the terminal
open until it completes.

### Optional flags

```bash
openclaw models auth login-github-copilot --profile-id github-copilot:work
openclaw models auth login-github-copilot --yes
```

## Set a default model

```bash
openclaw models set github-copilot/gpt-4o
```

### Config snippet

```json5
{
  agents: { defaults: { model: { primary: "github-copilot/gpt-4o" } } },
}
```

## Notes

- Requires an interactive TTY; run it directly in a terminal.
- Copilot model availability depends on your plan; if a model is rejected, try
  another ID (for example `github-copilot/gpt-4.1`).
- The login stores a GitHub token in the auth profile store and exchanges it for a
  Copilot API token when OpenClaw runs.

## Overriding model defaults

When new Copilot models ship (or existing definitions need corrections) before the
upstream registry is updated, you can override API types and context windows in
`openclaw.json`.

### Context window overrides for existing models

For models already in the registry, use per-model params — no explicit provider
entry needed:

```json
{
  "agents": {
    "defaults": {
      "models": {
        "github-copilot/claude-opus-4.6": {
          "params": { "contextWindow": 128000, "maxOutputTokens": 64000 }
        }
      }
    }
  }
}
```

### Adding a model not yet in the registry

Models not yet in the upstream registry need an explicit provider model entry
with all required fields including headers:

```json
{
  "models": {
    "providers": {
      "github-copilot": {
        "baseUrl": "https://api.individual.githubcopilot.com",
        "models": [
          {
            "id": "gpt-5.3-codex",
            "name": "gpt-5.3-codex",
            "api": "openai-responses",
            "reasoning": true,
            "input": ["text", "image"],
            "headers": {
              "User-Agent": "GitHubCopilotChat/0.35.0",
              "Editor-Version": "vscode/1.107.0",
              "Editor-Plugin-Version": "copilot-chat/0.35.0",
              "Copilot-Integration-Id": "vscode-chat"
            },
            "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
            "contextWindow": 128000,
            "maxTokens": 128000
          }
        ]
      }
    }
  }
}
```

<Note>
Explicit provider models require IDE headers (`Editor-Version`,
`Editor-Plugin-Version`, `Copilot-Integration-Id`). Built-in registry models
include these automatically.
</Note>

### API types

Copilot routes different model families through different API formats. Use the
correct `api` value when adding explicit model entries:

| Model family          | API type             |
| --------------------- | -------------------- |
| Claude (Opus, Sonnet) | `anthropic-messages` |
| GPT-5.x, Codex        | `openai-responses`   |
| GPT-4.x, Gemini, Grok | `openai-completions` |
