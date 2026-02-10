---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Sign in to GitHub Copilot from OpenClaw using the device flow"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You want to use GitHub Copilot as a model provider（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You need the `openclaw models auth login-github-copilot` flow（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "GitHub Copilot"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# GitHub Copilot（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## What is GitHub Copilot?（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
GitHub Copilot is GitHub's AI coding assistant. It provides access to Copilot（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
models for your GitHub account and plan. OpenClaw can use Copilot as a model（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
provider in two different ways.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Two ways to use Copilot in OpenClaw（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 1) Built-in GitHub Copilot provider (`github-copilot`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use the native device-login flow to obtain a GitHub token, then exchange it for（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Copilot API tokens when OpenClaw runs. This is the **default** and simplest path（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
because it does not require VS Code.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 2) Copilot Proxy plugin (`copilot-proxy`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use the **Copilot Proxy** VS Code extension as a local bridge. OpenClaw talks to（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
the proxy’s `/v1` endpoint and uses the model list you configure there. Choose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
this when you already run Copilot Proxy in VS Code or need to route through it.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
You must enable the plugin and keep the VS Code extension running.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use GitHub Copilot as a model provider (`github-copilot`). The login command runs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
the GitHub device flow, saves an auth profile, and updates your config to use that（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
profile.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## CLI setup（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw models auth login-github-copilot（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
You'll be prompted to visit a URL and enter a one-time code. Keep the terminal（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
open until it completes.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Optional flags（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw models auth login-github-copilot --profile-id github-copilot:work（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw models auth login-github-copilot --yes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Set a default model（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw models set github-copilot/gpt-4o（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Config snippet（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agents: { defaults: { model: { primary: "github-copilot/gpt-4o" } } },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Notes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Requires an interactive TTY; run it directly in a terminal.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Copilot model availability depends on your plan; if a model is rejected, try（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  another ID (for example `github-copilot/gpt-4.1`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The login stores a GitHub token in the auth profile store and exchanges it for a（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  Copilot API token when OpenClaw runs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
