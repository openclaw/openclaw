---
summary: "Overview of OpenClaw onboarding options and flows"
read_when:
  - Choosing an onboarding path
  - Setting up a new environment
title: "Onboarding overview"
sidebarTitle: "Onboarding Overview"
---

OpenClaw has two onboarding paths. The CLI path gets you to a working local
agent first, then lets that agent help configure optional features. The macOS
app provides a guided visual flow.

## Which path should I use?

|                | CLI onboarding                         | macOS app onboarding      |
| -------------- | -------------------------------------- | ------------------------- |
| **Platforms**  | macOS, Linux, Windows (native or WSL2) | macOS only                |
| **Interface**  | Terminal wizard                        | Guided UI + Crestodian chat |
| **Best for**   | Servers, headless, full control        | Desktop Mac, visual setup |
| **Automation** | `--non-interactive` for scripts        | Manual only               |
| **Command**    | `openclaw` or `openclaw onboard`       | Launch the app            |

Most users should start with **CLI onboarding** — it works everywhere and gives
you the most control.

## What onboarding configures

Default CLI onboarding sets up:

1. **Model provider and auth** — API key, OAuth, or setup token for your chosen provider
2. **Workspace** — directory for agent files, bootstrap templates, and memory

It securely configures and starts a temporary local Gateway, then opens the local
agent to help configure optional channel, Gateway network access, Tailscale,
search, skill, and plugin setup. The temporary Gateway stops when the assisted
TUI exits. Use `--flow advanced` when you want the full wizard instead.

## CLI onboarding

Run in any terminal:

```bash
openclaw onboard
```

Add `--install-daemon` to also install the background service in one step.

Full reference: [Onboarding (CLI)](/start/wizard)
CLI command docs: [`openclaw onboard`](/cli/onboard)

## macOS app onboarding

Open the OpenClaw app. For local setup, the first-run flow starts the Gateway,
then opens a Crestodian conversation that detects existing AI access, proposes
the workspace and config, and applies the plan after approval. Sensitive
credentials use masked input. Remote setup connects to an already-configured
Gateway instead.

Full reference: [Onboarding (macOS App)](/start/onboarding)

## Custom or unlisted providers

If your provider is not listed in onboarding, choose **Custom Provider** and
enter:

- Endpoint compatibility: OpenAI-compatible (`/chat/completions`), OpenAI Responses-compatible (`/responses`), Anthropic-compatible (`/messages`), or unknown (probes all three and auto-detects)
- Base URL and API key (API key is optional if the endpoint does not require one)
- Model ID and optional model alias

Multiple custom endpoints can coexist — each gets its own endpoint ID.

## Related

- [Getting started](/start/getting-started)
- [CLI setup reference](/start/wizard-cli-reference)
