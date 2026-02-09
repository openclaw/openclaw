---
summary: "Mag-sign in sa GitHub Copilot mula sa OpenClaw gamit ang device flow"
read_when:
  - Gusto mong gamitin ang GitHub Copilot bilang model provider
  - Kailangan mo ang `openclaw models auth login-github-copilot` flow
title: "GitHub Copilot"
---

# GitHub Copilot

## Ano ang GitHub Copilot?

GitHub Copilot is GitHub's AI coding assistant. It provides access to Copilot
models for your GitHub account and plan. OpenClaw can use Copilot as a model
provider in two different ways.

## Dalawang paraan para gamitin ang Copilot sa OpenClaw

### 1. Built-in na GitHub Copilot provider (`github-copilot`)

Use the native device-login flow to obtain a GitHub token, then exchange it for
Copilot API tokens when OpenClaw runs. This is the **default** and simplest path
because it does not require VS Code.

### 2. Copilot Proxy plugin (`copilot-proxy`)

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

### Mga opsyonal na flag

```bash
openclaw models auth login-github-copilot --profile-id github-copilot:work
openclaw models auth login-github-copilot --yes
```

## Magtakda ng default na model

```bash
openclaw models set github-copilot/gpt-4o
```

### Snippet ng config

```json5
{
  agents: { defaults: { model: { primary: "github-copilot/gpt-4o" } } },
}
```

## Mga tala

- Nangangailangan ng interactive TTY; patakbuhin ito nang direkta sa isang terminal.
- Ang availability ng Copilot model ay depende sa iyong plano; kung may model na ma-reject, subukan ang ibang ID (halimbawa `github-copilot/gpt-4.1`).
- Ang login ay nag-iimbak ng GitHub token sa auth profile store at ine-exchange ito para sa isang Copilot API token kapag tumatakbo ang OpenClaw.
