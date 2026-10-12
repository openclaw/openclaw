---
summary: "Overview of OpenClaw onboarding options and flows"
read_when:
  - Choosing an onboarding path
  - Setting up a new environment
title: "Onboarding overview"
sidebarTitle: "Onboarding Overview"
---

OpenClaw supports onboarding from the terminal, the macOS app, and the Linux
desktop companion. Every path establishes inference first: it detects existing
AI access, requires a live completion, and only then starts OpenClaw to
configure the remaining setup. During macOS onboarding, selecting an already
configured model verifies that route before opening the normal dashboard.
The terminal flow also offers the full classic wizard for detailed setup.

## Which path should I use?

|                | CLI onboarding                         | macOS app onboarding                                | Linux app onboarding                      |
| -------------- | -------------------------------------- | --------------------------------------------------- | ----------------------------------------- |
| **Platforms**  | macOS, Linux, Windows (native or WSL2) | macOS                                               | Linux                                     |
| **Interface**  | Terminal or guided setup               | Automatic first run with guided fallback            | Native desktop setup                      |
| **Gateway**    | Local or remote                        | Local, direct remote, or SSH                        | Local, direct remote, or SSH              |
| **Best for**   | Servers, headless, full control        | Desktop Mac, visual setup                           | Linux desktop, visual setup               |
| **Automation** | `--non-interactive` for scripts        | Automatic for fresh local installs                  | Manual only                               |
| **Start**      | `openclaw onboard`                     | [Download the macOS app](/platforms/macos#download) | [Install the Linux app](/platforms/linux) |

Most users should start with **CLI onboarding** — it works everywhere and gives
you the most control.

## What onboarding configures

The guided inference phase establishes only:

1. **Model provider and auth** — detected access or a verified provider sign-in,
   API key, or token
2. **Verified inference** — a real completion on the default agent's effective
   model

After that completion passes, OpenClaw can configure the workspace, Gateway,
Gateway service, channels, agents, plugins, and other optional features.

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

On a fresh install the guided flow offers **Quick start** and **Custom setup**,
detects the AI access you already have, verifies your one chosen connection with
a real completion, and only then configures the rest of the setup. Both lanes,
the provider picker, **Skip for now**, and the foreground Gateway are described
step by step in [Onboarding (CLI)](/start/wizard#guided-default).

After inference passes, OpenClaw can hand channel setup to a masked terminal
wizard. It does not open guided or classic provider setup. Exit OpenClaw and
run `openclaw onboard` to change the model provider or its authentication.

Use `openclaw onboard --classic` for detailed model/auth, channel, skill,
remote Gateway, or import setup. Adding `--install-daemon` also selects the
classic flow and installs the background service in one step. Use `openclaw
setup` for conversational non-inference setup and repair. `openclaw
onboard --modern` is a compatibility alias that uses the same live-inference
gate.

Full reference: [Onboarding (CLI)](/start/wizard)
CLI command docs: [`openclaw onboard`](/cli/onboard)

## macOS app onboarding

[Download the macOS app](/platforms/macos#download), then open it. On a fresh
install with no existing connection or configuration, the app prepares its local
runtime, starts its own Gateway, and opens guided onboarding in the dashboard.
It does not automatically connect to a discovered Gateway. Existing local and
remote setups keep their connection and native onboarding behavior.

The dashboard shows **Connecting your AI…** while automatic setup runs, then a
summary of the selected provider, model, and Gateway. You can select another
available provider, use a different Gateway, or review device permissions. If
sign-in is needed, choose **Sign in with ChatGPT** and follow the inline steps.
If automatic setup is unavailable, the summary explains the failed attempts and
offers native AI setup in the Mac app, or `openclaw onboard` in a browser.

After inference works, OpenClaw continues its existing guided conversation for
optional setup, including memory import and channels. You can dismiss the
summary; it stays dismissed for that Gateway. Fresh installs leave native
Claude/Codex conversation discovery off. Permissions are requested when needed
and remain available in **Settings → Permissions**.

If runtime preparation, Gateway startup, authentication, or dashboard loading
fails, native onboarding opens at the relevant step with the error visible.
The app menu also keeps native onboarding available for manual setup. Gateways
without automatic setup use the existing native AI setup flow.

Gemini CLI remains available as an explicitly configured runtime after setup,
but Gemini CLI and Antigravity are not offered as detected inference routes.
Use Google AI Studio API-key or Vertex AI for guided setup. The optional Gemini
CLI runtime specifically requires an AI Studio API-key profile.

Full reference: [Onboarding (macOS App)](/start/onboarding)

## Linux app onboarding

[Install the Linux desktop companion](/platforms/linux), then open it. The
welcome screen lets you choose a Gateway on **this computer** or **another
computer**. Local setup installs any missing CLI and Node in a private managed
runtime, then starts the systemd user service. Remote setup connects to a
discovered Gateway, a manually entered Gateway URL, or a Gateway reached through
an SSH tunnel;
token and password authentication are supported.

Model Setup checks existing provider access and offers sign-in or API-key entry
when needed. The selected Gateway verifies a real model response before guided
onboarding begins. An already configured Gateway opens the normal agent UI
after verification instead. Restart/reopen recovery uses a temporary record
bound to the Gateway, agent, and authentication: a known model is verified
without repeating activation, while an unknown result needs the explicit
**Verify & use selected model** action. Expiry, cleared or unavailable browser
storage, or changed connection ownership can prevent recovery. See
[First-run setup](/platforms/linux#first-run-setup) for recovery details.

Platform and remote-access details: [Linux app](/platforms/linux) and
[Remote access](/gateway/remote).

## Custom or unlisted providers

If your provider is not listed, run `openclaw onboard` in a terminal on the
Gateway host, choose **Custom Provider** (under **More…** when shown), and enter:

- Endpoint compatibility: OpenAI-compatible (`/chat/completions`), OpenAI Responses-compatible (`/responses`), Anthropic-compatible (`/messages`), or unknown (checks all three and auto-detects)
- Base URL and API key (API key is optional if the endpoint does not require one)
- Model ID and optional model alias

Multiple custom endpoints can coexist — each gets its own endpoint ID. Guided
setup verifies a real model reply before saving the provider and activating its
model. A failed or cancelled check preserves the previous configuration. The
classic wizard also retains its custom-provider setup.

If the endpoint refuses the connection or its hostname cannot be found, setup
reports the failed connection immediately instead of waiting through normal
chat retries. Start the server or correct the URL and network settings on the
Gateway host, then retry. Ordinary agent sessions keep their connection retries.

## Related

- [Getting started](/start/getting-started)
- [CLI setup reference](/start/wizard-cli-reference)
