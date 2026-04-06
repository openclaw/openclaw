---
summary: "Community proxy that wraps the Cursor CLI as an OpenAI-compatible API server"
read_when:
  - You want to use your Cursor subscription with OpenAI-compatible tools
  - You want a local API server that wraps the Cursor CLI (agent)
  - You want to use Cursor models from OpenClaw without per-token billing
title: "Cursor Agent API Proxy"
---

# Cursor Agent API Proxy

**cursor-agent-api-proxy** is a community tool that wraps the [Cursor CLI](https://cursor.com/cn/docs/cli/headless) (`agent` command) as an OpenAI-compatible API server. Use your Cursor subscription (Pro / Business) with any tool that speaks the OpenAI API format.

<Warning>
This path is technical compatibility only. Using the Cursor CLI in automated/proxy
workflows may conflict with Cursor's Terms of Service. Verify Cursor's current terms
before relying on this approach in production.
</Warning>

Works on macOS, Linux, and Windows.

## How It Works

```
Your App → cursor-agent-api-proxy → Cursor CLI (agent) → Cursor (via subscription)
  (OpenAI format)                     (stream-json)         (uses your login)
```

## Installation

Requires Node.js 20+ and an active Cursor subscription.

```bash
# 1. Install and authenticate the Cursor CLI
# macOS / Linux / WSL:
curl https://cursor.com/install -fsS | bash

# Windows PowerShell:
irm 'https://cursor.com/install?win32=true' | iex

# Then authenticate:
agent login
agent --list-models   # verify it works

# 2. Install and start the proxy
npm install -g cursor-agent-api-proxy
cursor-agent-api      # starts in background on http://localhost:4646

# 3. Verify
curl http://localhost:4646/health
```

<Tip>
**Headless environments:** skip `agent login` and set `CURSOR_API_KEY` instead.
Generate a key at [cursor.com/settings](https://cursor.com/settings).
</Tip>

## With OpenClaw

### During onboarding

When running `openclaw onboard`, at the **Model/Auth** step:

1. Provider type → **Custom Provider** (OpenAI-compatible)
2. Base URL → `http://localhost:4646/v1`
3. API Key → type `not-needed`
4. Default model → `auto`

### Existing setup

Edit the config file to add a custom provider:

```json5
{
  models: {
    providers: {
      cursor: {
        api: "openai-completions",
        baseUrl: "http://localhost:4646/v1",
        apiKey: "not-needed",
        models: [
          { id: "auto", name: "Auto" },
          { id: "opus-4.6", name: "Claude Opus 4.6" },
          { id: "sonnet-4.5", name: "Claude Sonnet 4.5" },
          { id: "composer-1.5", name: "Composer 1.5" },
        ],
      },
    },
  },
  agents: {
    defaults: {
      model: { primary: "cursor/auto" },
    },
  },
}
```

<Note>
Set `apiKey` to `"not-needed"` when authentication is handled by `agent login`.
To forward a specific Cursor API Key per-request, set it here instead.
The `models` array lists available models. Run `agent --list-models` to see all options.
</Note>

## Models

Model IDs match `agent --list-models` output directly:

| Model ID              | Description                    |
| --------------------- | ------------------------------ |
| `auto`                | Auto-select                    |
| `gpt-5.2`            | GPT-5.2                        |
| `gpt-5.3-codex`      | GPT-5.3 Codex                  |
| `opus-4.6-thinking`  | Claude Opus 4.6 (thinking)     |
| `sonnet-4.5-thinking`| Claude Sonnet 4.5 (thinking)   |
| `gemini-3-pro`       | Gemini 3 Pro                   |

Full list: `curl http://localhost:4646/v1/models` or `agent --list-models`.

## Process Management

```bash
cursor-agent-api              # start (background)
cursor-agent-api stop         # stop
cursor-agent-api restart      # restart
cursor-agent-api status       # check if running
cursor-agent-api run          # foreground (for debugging)
```

## Auto-start (Boot)

Register as a system service (cross-platform):

```bash
cursor-agent-api install      # register and start
cursor-agent-api uninstall    # remove
```

- macOS → LaunchAgent
- Windows → Task Scheduler
- Linux → systemd user service

## Links

- **npm:** [https://www.npmjs.com/package/cursor-agent-api-proxy](https://www.npmjs.com/package/cursor-agent-api-proxy)
- **GitHub:** [https://github.com/tageecc/cursor-agent-api-proxy](https://github.com/tageecc/cursor-agent-api-proxy)
- **Issues:** [https://github.com/tageecc/cursor-agent-api-proxy/issues](https://github.com/tageecc/cursor-agent-api-proxy/issues)

## Notes

- This is a **community tool**, not officially supported by Cursor or OpenClaw
- Requires an active Cursor subscription (Pro / Business) with the CLI authenticated
- The proxy runs locally, but requests are forwarded to Cursor's servers via the `agent` CLI (same as using Cursor IDE)
- Streaming responses are fully supported

## See Also

- [Claude Max API Proxy](/providers/claude-max-api-proxy) - Similar proxy for Claude subscriptions
- [OpenAI provider](/providers/openai) - For OpenAI/Codex subscriptions
