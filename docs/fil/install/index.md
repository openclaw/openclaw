---
summary: "I-install ang OpenClaw — installer script, npm/pnpm, mula sa source, Docker, at iba pa"
read_when:
  - Kailangan mo ng paraan ng pag-install bukod sa Getting Started quickstart
  - Gusto mong mag-deploy sa isang cloud platform
  - Kailangan mong mag-update, mag-migrate, o mag-uninstall
title: "I-install"
x-i18n:
  source_path: install/index.md
  source_hash: 67c029634ba38196
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:45:41Z
---

# I-install

Nasundan mo na ba ang [Getting Started](/start/getting-started)? Ayos na — ang pahinang ito ay para sa mga alternatibong paraan ng pag-install, mga tagubiling partikular sa platform, at maintenance.

## Mga kinakailangan sa system

- **[Node 22+](/install/node)** (ii-install ito ng [installer script](#install-methods) kung wala pa)
- macOS, Linux, o Windows
- `pnpm` kung magbi-build ka mula sa source

<Note>
Sa Windows, mariin naming inirerekomenda na patakbuhin ang OpenClaw sa ilalim ng [WSL2](https://learn.microsoft.com/en-us/windows/wsl/install).
</Note>

## Mga paraan ng pag-install

<Tip>
Ang **installer script** ang inirerekomendang paraan para i-install ang OpenClaw. Pinangangasiwaan nito ang pag-detect ng Node, pag-install, at onboarding sa iisang hakbang.
</Tip>

<AccordionGroup>
  <Accordion title="Installer script" icon="rocket" defaultOpen>
    Dina-download ang CLI, ini-install ito nang global sa pamamagitan ng npm, at inilulunsad ang onboarding wizard.

    <Tabs>
      <Tab title="macOS / Linux / WSL2">
        ```bash
        curl -fsSL https://openclaw.ai/install.sh | bash
        ```
      </Tab>
      <Tab title="Windows (PowerShell)">
        ```powershell
        iwr -useb https://openclaw.ai/install.ps1 | iex
        ```
      </Tab>
    </Tabs>

    Ayan na — pinapangasiwaan ng script ang pag-detect ng Node, pag-install, at onboarding.

    Para laktawan ang onboarding at i-install lang ang binary:

    <Tabs>
      <Tab title="macOS / Linux / WSL2">
        ```bash
        curl -fsSL https://openclaw.ai/install.sh | bash -s -- --no-onboard
        ```
      </Tab>
      <Tab title="Windows (PowerShell)">
        ```powershell
        & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -NoOnboard
        ```
      </Tab>
    </Tabs>

    Para sa lahat ng flag, env var, at mga opsyon para sa CI/automation, tingnan ang [Installer internals](/install/installer).

  </Accordion>

  <Accordion title="npm / pnpm" icon="package">
    Kung mayroon ka nang Node 22+ at mas gusto mong ikaw ang mag-manage ng pag-install:

    <Tabs>
      <Tab title="npm">
        ```bash
        npm install -g openclaw@latest
        openclaw onboard --install-daemon
        ```

        <Accordion title="may sharp build errors?">
          Kung may naka-install na libvips nang global (karaniwan sa macOS via Homebrew) at pumalya ang `sharp`, pilitin ang prebuilt binaries:

          ```bash
          SHARP_IGNORE_GLOBAL_LIBVIPS=1 npm install -g openclaw@latest
          ```

          Kung makita mo ang `sharp: Please add node-gyp to your dependencies`, mag-install ng build tooling (macOS: Xcode CLT + `npm install -g node-gyp`) o gamitin ang env var sa itaas.
        </Accordion>
      </Tab>
      <Tab title="pnpm">
        ```bash
        pnpm add -g openclaw@latest
        pnpm approve-builds -g        # approve openclaw, node-llama-cpp, sharp, etc.
        openclaw onboard --install-daemon
        ```

        <Note>
        Nangangailangan ang pnpm ng hayagang pag-apruba para sa mga package na may build scripts. Pagkatapos ipakita ng unang install ang babalang "Ignored build scripts", patakbuhin ang `pnpm approve-builds -g` at piliin ang mga nakalistang package.
        </Note>
      </Tab>
    </Tabs>

  </Accordion>

  <Accordion title="Mula sa source" icon="github">
    Para sa mga contributor o sinumang gustong magpatakbo mula sa isang lokal na checkout.

    <Steps>
      <Step title="I-clone at i-build">
        I-clone ang [OpenClaw repo](https://github.com/openclaw/openclaw) at mag-build:

        ```bash
        git clone https://github.com/openclaw/openclaw.git
        cd openclaw
        pnpm install
        pnpm ui:build
        pnpm build
        ```
      </Step>
      <Step title="I-link ang CLI">
        Gawing available nang global ang command na `openclaw`:

        ```bash
        pnpm link --global
        ```

        Bilang alternatibo, laktawan ang pag-link at patakbuhin ang mga command sa pamamagitan ng `pnpm openclaw ...` mula sa loob ng repo.
      </Step>
      <Step title="Patakbuhin ang onboarding">
        ```bash
        openclaw onboard --install-daemon
        ```
      </Step>
    </Steps>

    Para sa mas malalim na development workflows, tingnan ang [Setup](/start/setup).

  </Accordion>
</AccordionGroup>

## Iba pang mga paraan ng pag-install

<CardGroup cols={2}>
  <Card title="Docker" href="/install/docker" icon="container">
    Mga containerized o headless na deployment.
  </Card>
  <Card title="Nix" href="/install/nix" icon="snowflake">
    Deklaratibong pag-install sa pamamagitan ng Nix.
  </Card>
  <Card title="Ansible" href="/install/ansible" icon="server">
    Automated na provisioning ng fleet.
  </Card>
  <Card title="Bun" href="/install/bun" icon="zap">
    CLI-only na paggamit sa pamamagitan ng Bun runtime.
  </Card>
</CardGroup>

## Pagkatapos mag-install

I-verify na gumagana ang lahat:

```bash
openclaw doctor         # check for config issues
openclaw status         # gateway status
openclaw dashboard      # open the browser UI
```

## Pag-troubleshoot: `openclaw` not found

<Accordion title="PATH diagnosis at pag-aayos">
  Mabilis na diagnosis:

```bash
node -v
npm -v
npm prefix -g
echo "$PATH"
```

Kung ang `$(npm prefix -g)/bin` (macOS/Linux) o `$(npm prefix -g)` (Windows) ay **wala** sa iyong `$PATH`, hindi mahanap ng iyong shell ang mga global npm binary (kasama ang `openclaw`).

Ayusin — idagdag ito sa iyong shell startup file (`~/.zshrc` o `~/.bashrc`):

```bash
export PATH="$(npm prefix -g)/bin:$PATH"
```

Sa Windows, idagdag sa iyong PATH ang output ng `npm prefix -g`.

Pagkatapos, magbukas ng bagong terminal (o `rehash` sa zsh / `hash -r` sa bash).
</Accordion>

## Update / uninstall

<CardGroup cols={3}>
  <Card title="Pag-update" href="/install/updating" icon="refresh-cw">
    Panatilihing updated ang OpenClaw.
  </Card>
  <Card title="Pag-migrate" href="/install/migrating" icon="arrow-right">
    Lumipat sa isang bagong machine.
  </Card>
  <Card title="Uninstall" href="/install/uninstall" icon="trash-2">
    Ganap na alisin ang OpenClaw.
  </Card>
</CardGroup>
