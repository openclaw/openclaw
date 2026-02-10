---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Install OpenClaw — installer script, npm/pnpm, from source, Docker, and more"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You need an install method other than the Getting Started quickstart（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You want to deploy to a cloud platform（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You need to update, migrate, or uninstall（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Install"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Install（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Already followed [Getting Started](/start/getting-started)? You're all set — this page is for alternative install methods, platform-specific instructions, and maintenance.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## System requirements（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **[Node 22+](/install/node)** (the [installer script](#install-methods) will install it if missing)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- macOS, Linux, or Windows（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `pnpm` only if you build from source（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<Note>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
On Windows, we strongly recommend running OpenClaw under [WSL2](https://learn.microsoft.com/en-us/windows/wsl/install).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
</Note>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Install methods（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<Tip>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The **installer script** is the recommended way to install OpenClaw. It handles Node detection, installation, and onboarding in one step.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
</Tip>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<AccordionGroup>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Accordion title="Installer script" icon="rocket" defaultOpen>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    Downloads the CLI, installs it globally via npm, and launches the onboarding wizard.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    <Tabs>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      <Tab title="macOS / Linux / WSL2">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
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
    That's it — the script handles Node detection, installation, and onboarding.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    To skip onboarding and just install the binary:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    <Tabs>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      <Tab title="macOS / Linux / WSL2">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        ```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        curl -fsSL https://openclaw.ai/install.sh | bash -s -- --no-onboard（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      </Tab>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      <Tab title="Windows (PowerShell)">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        ```powershell（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -NoOnboard（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      </Tab>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    </Tabs>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    For all flags, env vars, and CI/automation options, see [Installer internals](/install/installer).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Accordion>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Accordion title="npm / pnpm" icon="package">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    If you already have Node 22+ and prefer to manage the install yourself:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    <Tabs>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      <Tab title="npm">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        ```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        npm install -g openclaw@latest（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        openclaw onboard --install-daemon（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        <Accordion title="sharp build errors?">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          If you have libvips installed globally (common on macOS via Homebrew) and `sharp` fails, force prebuilt binaries:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          ```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          SHARP_IGNORE_GLOBAL_LIBVIPS=1 npm install -g openclaw@latest（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          If you see `sharp: Please add node-gyp to your dependencies`, either install build tooling (macOS: Xcode CLT + `npm install -g node-gyp`) or use the env var above.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        </Accordion>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      </Tab>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      <Tab title="pnpm">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        ```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        pnpm add -g openclaw@latest（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        pnpm approve-builds -g        # approve openclaw, node-llama-cpp, sharp, etc.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        openclaw onboard --install-daemon（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        <Note>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        pnpm requires explicit approval for packages with build scripts. After the first install shows the "Ignored build scripts" warning, run `pnpm approve-builds -g` and select the listed packages.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        </Note>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      </Tab>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    </Tabs>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Accordion>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Accordion title="From source" icon="github">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    For contributors or anyone who wants to run from a local checkout.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    <Steps>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      <Step title="Clone and build">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        Clone the [OpenClaw repo](https://github.com/openclaw/openclaw) and build:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        ```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        git clone https://github.com/openclaw/openclaw.git（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        cd openclaw（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        pnpm install（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        pnpm ui:build（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        pnpm build（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      </Step>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      <Step title="Link the CLI">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        Make the `openclaw` command available globally:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        ```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        pnpm link --global（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        Alternatively, skip the link and run commands via `pnpm openclaw ...` from inside the repo.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      </Step>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      <Step title="Run onboarding">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        ```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        openclaw onboard --install-daemon（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      </Step>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    </Steps>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    For deeper development workflows, see [Setup](/start/setup).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Accordion>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
</AccordionGroup>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Other install methods（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<CardGroup cols={2}>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Card title="Docker" href="/install/docker" icon="container">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    Containerized or headless deployments.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Card>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Card title="Nix" href="/install/nix" icon="snowflake">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    Declarative install via Nix.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Card>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Card title="Ansible" href="/install/ansible" icon="server">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    Automated fleet provisioning.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Card>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Card title="Bun" href="/install/bun" icon="zap">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    CLI-only usage via the Bun runtime.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Card>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
</CardGroup>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## After install（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Verify everything is working:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw doctor         # check for config issues（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw status         # gateway status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw dashboard      # open the browser UI（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you need custom runtime paths, use:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `OPENCLAW_HOME` for home-directory based internal paths（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `OPENCLAW_STATE_DIR` for mutable state location（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `OPENCLAW_CONFIG_PATH` for config file location（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
See [Environment vars](/help/environment) for precedence and full details.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Troubleshooting: `openclaw` not found（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<Accordion title="PATH diagnosis and fix">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  Quick diagnosis:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
node -v（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
npm -v（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
npm prefix -g（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
echo "$PATH"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If `$(npm prefix -g)/bin` (macOS/Linux) or `$(npm prefix -g)` (Windows) is **not** in your `$PATH`, your shell can't find global npm binaries (including `openclaw`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Fix — add it to your shell startup file (`~/.zshrc` or `~/.bashrc`):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
export PATH="$(npm prefix -g)/bin:$PATH"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
On Windows, add the output of `npm prefix -g` to your PATH.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Then open a new terminal (or `rehash` in zsh / `hash -r` in bash).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
</Accordion>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Update / uninstall（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<CardGroup cols={3}>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Card title="Updating" href="/install/updating" icon="refresh-cw">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    Keep OpenClaw up to date.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Card>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Card title="Migrating" href="/install/migrating" icon="arrow-right">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    Move to a new machine.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Card>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Card title="Uninstall" href="/install/uninstall" icon="trash-2">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    Remove OpenClaw completely.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Card>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
</CardGroup>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
