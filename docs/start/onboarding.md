---
doc-schema-version: 1
summary: "First-run setup flow for OpenClaw (macOS app)"
read_when:
  - Setting up the macOS app for the first time
  - Choosing between a local and a remote Gateway during macOS setup
  - Connecting an AI provider from the macOS app
title: "Onboarding (macOS app)"
sidebarTitle: "Onboarding: macOS App"
---

Open OpenClaw.app to set up a Gateway on this Mac and connect an AI model.
The app includes its own runtime; you do not need to install Node or a package
manager. If you already use OpenClaw, setup keeps your existing connection.

<Tip>
[Download OpenClaw for macOS](/platforms/macos#download) first.
For terminal-based setup, see [Onboarding overview](/start/onboarding-overview).
</Tip>

## Automatic first run

On a fresh install, open the app and follow **Setting up OpenClaw on this Mac**:

1. The app prepares its runtime and starts a local Gateway.
2. The dashboard opens and connects available AI access.
3. A live AI test verifies the connection before guided setup continues.

An already configured model is kept. You can then set up optional features
and start chatting. To choose the connection yourself, select **Set up manually**.

Existing configurations and saved connections keep their settings; setup does
not automatically switch to a discovered Gateway. Older apps may open manual setup first; developer builds and Gateways without
automatic setup support use it instead. Nix mode and
background-only launches do not run automatic first setup.

If setup fails, the app opens the relevant manual step with the error visible.
If you close setup early, reopen it from the app menu.

## macOS prompts

These operating-system prompts can appear during setup; their timing can vary.

<Steps>
<Step title="Approve macOS warning">
The first time you open OpenClaw.app, macOS asks you to approve a downloaded
app. Click **Open** to continue.

<Frame>
<img src="/assets/macos-onboarding/01-macos-warning.jpeg" alt="macOS dialog that asks whether to open the downloaded OpenClaw app" />
</Frame>
</Step>
<Step title="Approve find local networks">
macOS may ask whether **OpenClaw** or **bun** may find devices on your local
network. Bun is the runtime included with OpenClaw.app's bundled Gateway. Choose
**Allow** when you want LAN discovery and access to a Gateway on another machine.
**Don't Allow** can prevent discovery and local-network connections.

A separate firewall prompt may ask whether **bun** can accept incoming network
connections. **Allow** permits incoming connections subject to your Gateway's
bind and authentication settings; **Don't Allow** can block other devices from
reaching this Mac's Gateway. These prompts do not change Gateway authentication
or enable a LAN listener. You can revisit local-network and firewall permissions
in macOS System Settings.

<Frame>
<img src="/assets/macos-onboarding/02-local-networks.jpeg" alt="macOS dialog that asks whether OpenClaw may find devices on the local network" />
</Frame>

macOS may also show a second local-network prompt that names **Bun** instead of
OpenClaw. The Gateway runs on the Bun runtime bundled inside `OpenClaw.app` and
advertises itself on the LAN over Bonjour, so macOS attributes that request to
Bun. Allow it if other devices should discover or connect to this Gateway over
the LAN. The Gateway binds to loopback by default, so a **This Mac (Local only)**
setup keeps working if you choose **Don't Allow**. You can change it later in
**System Settings -> Privacy & Security -> Local Network**.

First launch can also open a macOS prompt to install Git or the Xcode Command
Line Tools. OpenClaw runs `git --version` when it creates a brand-new agent
workspace so it can track that workspace with `git init`. Git is optional: if
you cancel the prompt, the workspace is created without a Git repository, and
installing the tools later with `xcode-select --install` does not initialize
that workspace. To track it in Git, initialize it yourself as described in
[Agent workspace](/concepts/agent-workspace#git-backup-recommended-private).
</Step>
</Steps>

## Manual setup

Choose **Set up manually** to use these steps. The app also opens them when
automatic setup cannot finish. The screenshots show an earlier manual flow;
your build may use different labels or layouts.

<Steps>
<Step title="Read the security notice">
<a id="welcome-and-security-notice" />
OpenClaw is a personal agent designed for one trusted operator. For shared use,
separate trust boundaries and limit tool access; see [Security](/gateway/security).
Use a strong modern model and strict tool policy or sandboxing when enabling
hooks, webhooks, or other untrusted content feeds.

Local setup defaults to `tools.profile: "full"` only if no profile is set.
Existing profiles and tool policies stay unchanged. A full tool profile does
not grant execution permissions. See [Tool profiles](/gateway/config-tools/tool-policy#tool-profiles).
These rules apply to automatic setup too.

<Frame>
<img src="/assets/macos-onboarding/03-security-notice.png" alt="OpenClaw welcome screen with the security notice" />
</Frame>
</Step>
<Step title="Choose where the Gateway runs">
<a id="local-vs-remote" />

- **This Mac (Local only):** set up authentication and save credentials on this Mac.
- **Remote (over SSH/Tailnet):** connect to a Gateway that already has credentials
  on its host. The app does not configure local authentication. Its remote token
  field saves the connection token and preserves an existing
  `gateway.remote.token` SecretRef until you replace it.
- **Configure later:** leave the app unconfigured.

<Frame>
<img src="/assets/macos-onboarding/04-choose-gateway.png" alt="Manual setup choices for a local or remote Gateway" />
</Frame>

<Tip>
Gateway authentication defaults to `token`, even for local WebSocket clients.
Use a token for access from other machines. `gateway.auth.mode: "none"` lets
any local process connect; use it only on a fully trusted machine.
</Tip>
</Step>
<Step title="Prepare the local runtime">
<a id="cli" />
Wait for **Getting things ready** to finish. This step appears only when local
runtime setup is needed. Connecting to an independently managed Gateway skips
installation without taking over its CLI or service. See
[Gateway on macOS](/platforms/mac/bundled-gateway#automatic-setup) for runtime details.

macOS may offer to install Command Line Tools when OpenClaw initializes Git in
a new workspace. Git is optional; setup continues without it. Install the tools
if you want to use Git.
</Step>
<Step title="Connect your AI">
Choose a detected connection, sign in to a provider, or enter an API key or
token. The manual picker waits for your choice before testing, installing,
or saving anything. Setup must pass a live AI test before you can continue.

See [AI connection options](/start/onboarding#ai-connection-options) below for login reuse,
local models, and custom endpoints.
</Step>
<Step title="Continue in the dashboard">
A newly verified model opens guided setup for your workspace, Gateway,
channels, and optional features, then agent chat. An already configured model
opens the normal dashboard.

- **Import memory (optional):** choose files during guided setup or later in
  **Settings → Import Memory**. Local Gateways can import Claude Code, Codex,
  and Hermes memories into `memory/imports/`; previously imported files are skipped.
- **Grant macOS access as needed:** open **Settings → This Mac → Permissions** for features
  such as screen recording, microphone access, and automation. See
  [macOS permissions](/platforms/mac/permissions) for the full list and recovery steps.

See [Bootstrapping](/start/bootstrapping) for the agent's first turn.
You can return to **Settings → OpenClaw** later.
</Step>
</Steps>

## AI connection options

The dashboard shows the selected connection and alternatives. Change models
in its provider and model settings, or choose **Connection… → Gateways** to
switch Gateways. AI setup always runs on the Gateway host, even when your Mac
connects to a Linux Gateway.

### Automatic selection

If no model is configured, automatic setup checks these sources in order:

1. Saved OpenClaw auth profiles.
2. Codex credentials in `CODEX_HOME` or `~/.codex` on the Gateway host.
3. A Claude CLI login.
4. `OPENAI_API_KEY`, then `ANTHROPIC_API_KEY`.
5. Eligible loaded models in Ollama, LM Studio, or llama.cpp.

It tries at most four detected connections and saves the first model that
passes a live completion test. Apple Foundation Models is a utility option,
not a primary model.

If none works, setup installs or enables the official Codex plugin, then reuses
a Codex login or offers ChatGPT sign-in. This is the only plugin capability
approval automatic setup grants. If it fails, the dashboard shows the reason
and lets you choose another connection.

### Codex login and isolation

Choose whether to share your existing Codex state:

| Mode         | What it uses                                                               |
| ------------ | -------------------------------------------------------------------------- |
| **Reuse**    | Your existing Codex login, threads, and `config.toml` on the Gateway host. |
| **Separate** | An OpenClaw-owned login and agent home.                                    |

When automatic setup selects an existing Codex ChatGPT or API-key login, it
uses **Reuse**. Without an existing login,
the offered ChatGPT sign-in uses a separate home. To switch, choose **Sign in separately** on the setup card, or sign in with ChatGPT or an OpenAI API key
in **Models**. Completing that sign-in selects the isolated home.

Choosing a Claude or Codex model does not automatically show native
conversations in the sidebar. Enable conversation discovery separately if you want to browse them.
For shared-home settings and authentication details, see
[Native Codex state](/plugins/codex-harness/native-features#share-threads-with-codex-desktop-and-cli).

### Other connections

<AccordionGroup>
<Accordion title="Local models">
Discovery checks loaded models; it never downloads one. For an eligible Ollama
model installed on disk but not loaded, use **Choose connection → Local only**.
See [Ollama](/providers/ollama).
</Accordion>
<Accordion title="Provider sign-in, API keys, and tokens">
Choose a provider in the picker and follow its sign-in or key/token prompts.
Available providers depend on your Gateway's plugins; some can be installed
from the picker. See [Model providers](/providers) for provider-specific setup.

To use a Claude subscription without a Claude CLI login on the Gateway host,
run `claude setup-token` on a machine with Claude Code. Paste the result as
**Anthropic setup-token** under **Connect with an API key or token**.
</Accordion>
<Accordion title="Custom endpoints">
For a local Gateway, choose **Custom OpenAI/Anthropic-compatible endpoint**
and follow the wizard. For a remote Gateway, run this on the Gateway host:

```bash
openclaw onboard --auth-choice custom-api-key
```

Then refresh detection in the app. The Mac does not collect the remote host's secret.
</Accordion>
<Accordion title="Plugin approval and replacing a sign-in">
When a connection needs a runtime plugin, review its source, capabilities, and
integrity (when available), then confirm installation or activation. This also
applies to verified first-party packages in manual setup.

Declining stops the attempt without choosing another route. If confirmation
fails, retry the saved sign-in in **Models**; your credential and any
plugins installed for that attempt are kept.

A replacement sign-in becomes active only after verification and your acceptance
of **Activate this saved sign-in?** Declining keeps your current connection and
the saved replacement. If connection settings changed during verification,
review them and retry instead of overwriting the newer settings.
</Accordion>
</AccordionGroup>

## If AI setup stalls

- **An earlier attempt may still be running:** choose **Check again** to check
  its status without starting another activation. Wait for it to finish before
  replacing the connection.
- **The wait ends without a confirmed result:** setup returns to connection
  choices with the error visible. Retry that connection or choose another;
  it does not automatically retry detected credentials.
- **You want to cancel:** choose **Cancel** and wait for confirmation. If the
  sheet says setup may still be running, retry **Cancel**.

## Related

- [Onboarding overview](/start/onboarding-overview)
- [Getting started](/start/getting-started)
