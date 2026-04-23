---
summary: "Get OpenClaw installed and run your first chat in minutes."
read_when:
  - First time setup from zero
  - You want the fastest path to a working chat
title: "Getting Started"
---

# Getting Started

Install OpenClaw, run onboarding, and chat with your AI assistant — all in
about 5 minutes. By the end you will have a running Gateway, configured auth,
and a working chat session.

## What you need

The installer detects and installs missing dependencies automatically. Run the
checks in [Step 0](#step-0-check-prerequisites) if you'd rather verify or
install them yourself.

- **Node.js** — Node 24 recommended (Node 22.14+ also supported) — `node --version`
- **npm** — bundled with Node — `npm --version`
- **git** — `git --version`
- **curl** (macOS / Linux) — `curl --version`
- **bash** 4+ (macOS / Linux) — `bash --version`
- **openssl** — `openssl version`
- **pnpm** — only needed if you build from source — `pnpm --version`
- **An API key** from a model provider (Anthropic, OpenAI, Google, etc.) — onboarding will prompt you

<Tip>
**Windows users:** both native Windows and WSL2 are supported. WSL2 is more
stable and recommended for the full experience. See [Windows](/platforms/windows).
Need to install Node? See [Node setup](/install/node).
</Tip>

## Step 0: Check prerequisites

The install script auto-installs anything missing, but you can verify upfront.
Run the matching one-liner — any line that fails or prints an old version
points at a dependency to install.

<Tabs>
  <Tab title="macOS / Linux">
    ```bash
    for c in "node --version" "npm --version" "git --version" "curl --version" "bash --version" "openssl version"; do
      printf "%-18s " "$c:"; eval "$c" 2>&1 | head -n 1 || echo "MISSING"
    done
    ```

    Install anything missing:

    - **macOS** (Homebrew): `brew install node git curl openssl`
    - **Ubuntu / Debian**: `sudo apt-get install -y nodejs npm git curl openssl ca-certificates`
    - **Fedora / RHEL**: `sudo dnf install -y nodejs npm git curl openssl`
    - **Arch**: `sudo pacman -S --needed nodejs npm git curl openssl`

    For Node specifically, see [Node setup](/install/node) for version managers
    (fnm, nvm, mise) and PATH troubleshooting.

  </Tab>
  <Tab title="Windows (PowerShell)">
    ```powershell
    foreach ($c in 'node --version','npm --version','git --version','openssl version') {
      Write-Host -NoNewline "${c}: "
      try { & cmd /c $c } catch { Write-Host 'MISSING' }
    }
    ```

    Install anything missing with **winget**:

    ```powershell
    winget install OpenJS.NodeJS.LTS Git.Git ShiningLight.OpenSSL.Light
    ```

    `curl` and `bash` ship with Git for Windows. For the full experience,
    WSL2 is recommended — see [Windows](/platforms/windows).

  </Tab>
</Tabs>

<Note>
`pnpm` is only required if you build from source. Install with
`npm install -g pnpm` or `corepack enable pnpm`.
</Note>

## Quick setup

<Steps>
  <Step title="Install OpenClaw">
    <Tabs>
      <Tab title="macOS / Linux">
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
    Other install methods (Docker, Nix, npm): [Install](/install).
    </Note>

  </Step>
  <Step title="Run onboarding">
    ```bash
    openclaw onboard --install-daemon
    ```

    The wizard walks you through choosing a model provider, setting an API key,
    and configuring the Gateway. It takes about 2 minutes.

    See [Onboarding (CLI)](/start/wizard) for the full reference.

  </Step>
  <Step title="Verify the Gateway is running">
    ```bash
    openclaw gateway status
    ```

    You should see the Gateway listening on port 18789.

  </Step>
  <Step title="Open the dashboard">
    ```bash
    openclaw dashboard
    ```

    This opens the Control UI in your browser. If it loads, everything is working.

  </Step>
  <Step title="Send your first message">
    Type a message in the Control UI chat and you should get an AI reply.

    Want to chat from your phone instead? The fastest channel to set up is
    [Telegram](/channels/telegram) (just a bot token). See [Channels](/channels)
    for all options.

  </Step>
</Steps>

<Accordion title="Advanced: mount a custom Control UI build">
  If you maintain a localized or customized dashboard build, point
  `gateway.controlUi.root` to a directory that contains your built static
  assets and `index.html`.

```bash
mkdir -p "$HOME/.openclaw/control-ui-custom"
# Copy your built static files into that directory.
```

Then set:

```json
{
  "gateway": {
    "controlUi": {
      "enabled": true,
      "root": "$HOME/.openclaw/control-ui-custom"
    }
  }
}
```

Restart the gateway and reopen the dashboard:

```bash
openclaw gateway restart
openclaw dashboard
```

</Accordion>

## What to do next

<Columns>
  <Card title="Connect a channel" href="/channels" icon="message-square">
    Discord, Feishu, iMessage, Matrix, Microsoft Teams, Signal, Slack, Telegram, WhatsApp, Zalo, and more.
  </Card>
  <Card title="Pairing and safety" href="/channels/pairing" icon="shield">
    Control who can message your agent.
  </Card>
  <Card title="Configure the Gateway" href="/gateway/configuration" icon="settings">
    Models, tools, sandbox, and advanced settings.
  </Card>
  <Card title="Browse tools" href="/tools" icon="wrench">
    Browser, exec, web search, skills, and plugins.
  </Card>
</Columns>

<Accordion title="Advanced: environment variables">
  If you run OpenClaw as a service account or want custom paths:

- `OPENCLAW_HOME` — home directory for internal path resolution
- `OPENCLAW_STATE_DIR` — override the state directory
- `OPENCLAW_CONFIG_PATH` — override the config file path

Full reference: [Environment variables](/help/environment).
</Accordion>
