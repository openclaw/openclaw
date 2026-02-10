---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Get OpenClaw installed and run your first chat in minutes."（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - First time setup from zero（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You want the fastest path to a working chat（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Getting Started"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Getting Started（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Goal: go from zero to a first working chat with minimal setup.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<Info>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Fastest chat: open the Control UI (no channel setup needed). Run `openclaw dashboard`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
and chat in the browser, or open `http://127.0.0.1:18789/` on the（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<Tooltip headline="Gateway host" tip="The machine running the OpenClaw gateway service.">gateway host</Tooltip>.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Docs: [Dashboard](/web/dashboard) and [Control UI](/web/control-ui).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
</Info>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Prereqs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Node 22 or newer（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<Tip>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Check your Node version with `node --version` if you are unsure.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
</Tip>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Quick setup (CLI)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<Steps>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Step title="Install OpenClaw (recommended)">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    <Tabs>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      <Tab title="macOS/Linux">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        ```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        curl -fsSL https://openclaw.ai/install.sh | bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      </Tab>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      <Tab title="Windows (PowerShell)">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        ```powershell（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        iwr -useb https://openclaw.ai/install.ps1 | iex（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      </Tab>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    </Tabs>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    <Note>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    Other install methods and requirements: [Install](/install).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    </Note>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Step>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Step title="Run the onboarding wizard">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    openclaw onboard --install-daemon（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    The wizard configures auth, gateway settings, and optional channels.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    See [Onboarding Wizard](/start/wizard) for details.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Step>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Step title="Check the Gateway">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    If you installed the service, it should already be running:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    openclaw gateway status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Step>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Step title="Open the Control UI">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    openclaw dashboard（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Step>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
</Steps>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<Check>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If the Control UI loads, your Gateway is ready for use.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
</Check>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Optional checks and extras（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<AccordionGroup>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Accordion title="Run the Gateway in the foreground">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    Useful for quick tests or troubleshooting.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    openclaw gateway --port 18789（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Accordion>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Accordion title="Send a test message">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    Requires a configured channel.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    openclaw message send --target +15555550123 --message "Hello from OpenClaw"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Accordion>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
</AccordionGroup>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Useful environment variables（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you run OpenClaw as a service account or want custom config/state locations:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `OPENCLAW_HOME` sets the home directory used for internal path resolution.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `OPENCLAW_STATE_DIR` overrides the state directory.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `OPENCLAW_CONFIG_PATH` overrides the config file path.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Full environment variable reference: [Environment vars](/help/environment).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Go deeper（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<Columns>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Card title="Onboarding Wizard (details)" href="/start/wizard">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    Full CLI wizard reference and advanced options.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Card>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Card title="macOS app onboarding" href="/start/onboarding">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    First run flow for the macOS app.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Card>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
</Columns>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## What you will have（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- A running Gateway（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Auth configured（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Control UI access or a connected channel（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Next steps（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- DM safety and approvals: [Pairing](/channels/pairing)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Connect more channels: [Channels](/channels)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Advanced workflows and from source: [Setup](/start/setup)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
