---
summary: "Get OpenClaw installed and run your first chat in minutes."
read_when:
  - First time setup from zero
  - You want the fastest path to a working chat
title: "Getting Started"
---

# Getting Started

Goal: go from zero to a first working chat with minimal setup.

<Info>
Fastest chat: open the Control UI (no channel setup needed). Run `openclaw dashboard`
and chat in the browser, or open `http://127.0.0.1:18789/` on the
<Tooltip headline="Gateway host" tip="The machine running the OpenClaw gateway service.">gateway host</Tooltip>.
Docs: [Dashboard](/web/dashboard) and [Control UI](/web/control-ui).
</Info>

## Prereqs

- Node 24 recommended (Node 22 LTS, currently `22.16+`, still supported for compatibility)
- An API key from a model provider (Anthropic, OpenAI, Google, etc.) — onboarding will prompt you for this

<Tip>
Check your Node version with `node --version` if you are unsure.
Windows users: WSL2 is strongly recommended. See [Windows](/platforms/windows).
</Tip>

## Quick setup (CLI)

<Steps>
  <Step title="Install OpenClaw (recommended)">
    <Tabs>
      <Tab title="macOS/Linux">
        ```bash
        curl -fsSL https://openclaw.ai/install.sh | bash
        ```
        <img
  src="/assets/install-script.svg"
  alt="Install Script Process"
  className="rounded-lg"
/>
      </Tab>
      <Tab title="Windows (PowerShell)">
        ```powershell
        iwr -useb https://openclaw.ai/install.ps1 | iex
        ```
      </Tab>
    </Tabs>

    <Note>
    Other install methods and requirements: [Install](/install).
    </Note>

  </Step>
  <Step title="Run onboarding">
    ```bash
    openclaw onboard --install-daemon
    ```

    Onboarding configures auth, gateway settings, and optional channels.
    See [Onboarding (CLI)](/start/wizard) for details.

  </Step>
  <Step title="Check the Gateway">
    If you installed the service, it should already be running:

    ```bash
    openclaw gateway status
    ```

  </Step>
  <Step title="Open the Control UI">
    ```bash
    openclaw dashboard
    ```

    If the Control UI loads, your Gateway is ready.

  </Step>
  <Step title="Send your first message">
    The fastest way to chat is directly in the Control UI browser tab.
    Type a message and you should get an AI reply.

    Want to chat from a messaging app instead? The fastest channel setup
    is usually [Telegram](/channels/telegram) (just a bot token, no QR
    pairing). See [Channels](/channels) for all options.

  </Step>
</Steps>

## Useful environment variables

If you run OpenClaw as a service account or want custom config/state locations:

- `OPENCLAW_HOME` sets the home directory used for internal path resolution.
- `OPENCLAW_STATE_DIR` overrides the state directory.
- `OPENCLAW_CONFIG_PATH` overrides the config file path.

Full environment variable reference: [Environment vars](/help/environment).

## Go deeper

<Columns>
  <Card title="Onboarding (CLI)" href="/start/wizard">
    Full CLI onboarding reference and advanced options.
  </Card>
  <Card title="macOS app onboarding" href="/start/onboarding">
    First run flow for the macOS app.
  </Card>
</Columns>

## What you will have

- A running Gateway
- Auth configured
- Control UI access or a connected channel

## Next steps

- DM safety and approvals: [Pairing](/channels/pairing)
- Connect more channels: [Channels](/channels)
- Advanced workflows and from source: [Setup](/start/setup)
