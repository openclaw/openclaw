---
summary: "Overview of OpenClaw onboarding options and flows"
read_when:
  - Choosing an onboarding path
  - Setting up a new environment
title: "Onboarding overview"
sidebarTitle: "Onboarding Overview"
---

OpenClaw has terminal and macOS app onboarding. Both establish inference first:
they detect existing AI access, require a live completion, and only then start
Crestodian to configure the remaining setup. A reachable, configured Gateway
whose agent already has a working model skips onboarding and opens the normal
agent UI. The terminal flow also offers the full classic wizard for detailed
setup.

## Which path should I use?

|                | CLI onboarding                         | macOS app onboarding             |
| -------------- | -------------------------------------- | -------------------------------- |
| **Platforms**  | macOS, Linux, Windows (native or WSL2) | macOS only                       |
| **Interface**  | Inference setup, then Crestodian       | Inference setup, then Crestodian |
| **Best for**   | Servers, headless, full control        | Desktop Mac, visual setup        |
| **Automation** | `--non-interactive` for scripts        | Manual only                      |
| **Command**    | `openclaw onboard`                     | Launch the app                   |

Most users should start with **CLI onboarding** — it works everywhere and gives
you the most control.

## What onboarding configures

Guided onboarding sets up:

1. **Model provider and auth** — detected access or a verified API key
2. **Workspace** — directory for agent files, bootstrap templates, and memory
3. **Gateway** — port, bind address, auth mode
4. **Gateway service** — installs, starts, and probes the local Gateway

The classic CLI wizard can additionally configure:

1. **Channels** (optional) — built-in and bundled chat channels such as
   Discord, Feishu, Google Chat, iMessage, Mattermost, Microsoft Teams,
   Telegram, WhatsApp, and more
2. **Advanced Gateway controls** — remote mode, network settings, and daemon choices

## CLI onboarding

Run in any terminal:

```bash
openclaw onboard
```

The guided flow detects existing AI access, live-tests candidates in order,
falls through on failure, and offers masked manual key entry. It saves the
model and credential only after a passing completion, then starts Crestodian
to configure channels, agents, plugins, and other optional features. Before
that live boundary, the available escape is the classic wizard; there is no
pre-inference Crestodian or skip-AI path.

After inference passes, Crestodian can open guided setup, classic setup, or a
masked channel wizard without making you restart the command manually.

Use `openclaw onboard --classic` for detailed model/auth, channel, skill,
remote Gateway, or import setup. Adding `--install-daemon` also selects the
classic flow and installs the background service in one step. Use `openclaw
crestodian` for conversational setup and repair. `openclaw onboard --modern`
is a compatibility alias that uses the same live-inference gate.

Full reference: [Onboarding (CLI)](/start/wizard)
CLI command docs: [`openclaw onboard`](/cli/onboard)

## macOS app onboarding

Open the OpenClaw app. If its configured local or remote Gateway is reachable
and the default agent already has a working model, the app skips onboarding
and Crestodian and opens the normal agent UI immediately.

For a fresh or incomplete Gateway, the first-run flow detects existing AI
access (Claude Code, Codex, Gemini CLI, or API keys), live-tests the best
option, and saves it only after a real reply — falling back automatically and
offering a verified manual API-key step when nothing is found. Sensitive
credentials use masked input. Once inference passes, Crestodian starts and
helps configure the rest.

Full reference: [Onboarding (macOS App)](/start/onboarding)

## Custom or unlisted providers

If your provider is not listed, open the classic wizard, choose **Custom
Provider**, and enter:

- Endpoint compatibility: OpenAI-compatible (`/chat/completions`), OpenAI Responses-compatible (`/responses`), Anthropic-compatible (`/messages`), or unknown (probes all three and auto-detects)
- Base URL and API key (API key is optional if the endpoint does not require one)
- Model ID and optional model alias

Multiple custom endpoints can coexist — each gets its own endpoint ID.

## Related

- [Getting started](/start/getting-started)
- [CLI setup reference](/start/wizard-cli-reference)
