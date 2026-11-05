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

Automatic first run applies only when there is no existing configuration,
saved Gateway profile, connection setting, or previous onboarding. It never
selects a discovered Gateway automatically. Existing local and remote setups
keep their connections and open manual onboarding only if needed.

Older apps and unbundled developer builds may open manual setup first.
Nix mode and background-only launches do not run automatic first setup.
If setup fails, the app opens the relevant manual step and shows the error.
A Gateway without automatic setup support opens the AI picker instead.
If you close setup before the dashboard opens, reopen it from the app menu.

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
The **Getting things ready** page appears only when local setup is needed.
The app prepares its bundled Bun runtime and matching CLI, Gateway, and
Control UI. It includes no Node executable and needs no global npm, pnpm,
or Bun installation.

Connecting to an independently managed local Gateway skips installation and
goes straight to AI checks. The app does not take over that Gateway's CLI or
service. See [Gateway on macOS](/platforms/mac/bundled-gateway#automatic-setup).

<Accordion title="Developer builds and the Git prompt">
Unbundled DEBUG builds use a separate installer and channel chooser. They can
reuse a compatible CLI or install OpenClaw and Node in a private runtime.

For a new workspace without Git metadata, OpenClaw runs `git --version` and,
if available, `git init`. Apple's Git stub may prompt you to install Command
Line Tools. Git is optional: workspace creation continues if it is missing or
initialization fails. Install the tools if you want Git in the workspace.
</Accordion>
</Step>
<Step title="Connect your AI">
Choose a detected connection, sign in to a provider, or enter an API key or
token. The manual picker waits for your choice before testing, installing,
or saving anything. Setup must pass a live AI test before you can continue.

The setup sheet shows the provider and current activity. Answer any review or
sign-in prompts; plugin installation and the final AI test stay in the same
flow. Installation shows a spinner, not an estimated percentage.

See [AI connection options](/start/onboarding#ai-connection-options) below for login reuse,
local models, and custom endpoints.
</Step>
<Step title="Continue in the dashboard">
A newly verified model opens guided setup for your workspace, Gateway,
channels, and optional features, then agent chat. An already configured model
opens the normal dashboard.

- **Import memory (optional):** choose files during guided setup or later in
  **Settings → Import Memory**. Local Gateways support Claude Code auto-memory,
  Codex consolidated memories, and Hermes memory files. Files are copied to
  `memory/imports/` for indexed recall; previously imported files are skipped.
- **Grant macOS access as needed:** open **Settings → Permissions**. There is
  no separate native permissions walkthrough. Options include Automation
  (AppleScript), Notifications, Accessibility, Screen Recording, Microphone,
  Speech Recognition, Camera, and Location. See [macOS permissions](/platforms/mac/permissions).

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
the offered ChatGPT sign-in uses a separate home. To switch, choose **Use a
separate login** on the setup card, or sign in with ChatGPT or an OpenAI API key
in **Model Setup**. Completing that sign-in selects the isolated home.

<Accordion title="Codex home settings and conversation discovery">
Reuse sets `plugins.entries.codex.config.appServer.homeScope: "user"`, so
Codex uses `CODEX_HOME` or, when unset, `~/.codex`. Codex handles authentication
and token refresh; OpenClaw does not copy OAuth tokens into its auth store.
Manual setup keeps its existing API-key import behavior. See
[Native Codex state](/plugins/codex-harness/native-features#share-threads-with-codex-desktop-and-cli).

Native Claude/Codex conversation discovery stays off during automatic setup.
Enable it separately to show native conversations in the sidebar without
copying transcripts. Choosing a Claude or Codex model does not enable it.
</Accordion>

### Other connections

<AccordionGroup>
<Accordion title="Local models">
Discovery never downloads models. Ollama checks `/api/ps` for loaded models.
For an eligible model installed on disk but not loaded, use **Choose connection
→ Local only**. See [Ollama](/providers/ollama).
</Accordion>
<Accordion title="Provider sign-in, API keys, and tokens">
The picker uses installed provider manifests and the official plugin catalog,
so providers such as Meta can appear before their plugin is installed.
OAuth and device-pairing choices include Chutes, GitHub Copilot, MiniMax Global
and CN, OpenAI/ChatGPT, OpenRouter, and xAI. Google uses an AI Studio API key.
Available choices come from active text-inference plugins, not a fixed app list;
the key/token picker uses the same registry.

To use a Claude subscription without a Claude CLI login on the Gateway host,
run `claude setup-token` on a machine with Claude Code. Paste the result as
**Anthropic setup-token** under **Connect with an API key or token**.

Pi and OpenCode may appear for context, but are whole-agent harnesses rather
than reusable setup inference routes. Their session integrations need separate
runtime and plugin setup. Gemini CLI and Antigravity are not detected setup routes.

Each provider supplies its starter model and configuration. OpenClaw resolves
starter aliases to full model names for testing and saving, preserving existing
model settings the starter does not replace.
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

Declining or confirming cancellation stops the attempt; setup does not choose
another route. If confirmation fails, the app keeps the saved credential and
any plugins installed for that attempt. Retry the saved sign-in in **Model Setup**
without signing in again.

A replacement credential stays inactive until verification finishes and you
accept **Activate this saved sign-in?** Declining keeps both your current
connection and the saved replacement. Unrelated configuration edits are
preserved. If the same connection settings changed during verification, review
them and retry the saved sign-in instead of overwriting the newer settings.
</Accordion>
</AccordionGroup>

## If AI setup stalls

- **An earlier attempt may still be running:** choose **Check again**. This
  checks the existing attempt; it does not start another activation, discard
  the attempt, or shorten the wait. Replacement setup stays blocked meanwhile.
- **The wait ends without a confirmed result:** setup returns to connection
  choices with the error visible. Retry that connection or choose another;
  it does not automatically retry detected credentials.
- **You want to cancel:** choose **Cancel** and wait for confirmation. The
  Gateway may need to finish an operation it has already committed to. If
  cancellation cannot be confirmed, the sheet warns that setup may still be
  running and lets you retry **Cancel**.

## Related

- [Onboarding overview](/start/onboarding-overview)
- [Getting started](/start/getting-started)
