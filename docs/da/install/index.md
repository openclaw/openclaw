---
summary: "Installér OpenClaw — installationsscript, npm/pnpm, fra kilde, Docker og mere"
read_when:
  - Du har brug for en installationsmetode ud over Kom godt i gang-quickstarten
  - Du vil udrulle til en cloudplatform
  - Du skal opdatere, migrere eller afinstallere
title: "Installér"
x-i18n:
  source_path: install/index.md
  source_hash: 67c029634ba38196
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:24Z
---

# Installér

Har du allerede fulgt [Kom godt i gang](/start/getting-started)? Så er du klar — denne side er til alternative installationsmetoder, platformspecifikke instruktioner og vedligeholdelse.

## Systemkrav

- **[Node 22+](/install/node)** (installationsscriptet vil installere det, hvis det mangler)
- macOS, Linux eller Windows
- `pnpm` kun hvis du bygger fra kilde

<Note>
På Windows anbefaler vi kraftigt at køre OpenClaw under [WSL2](https://learn.microsoft.com/en-us/windows/wsl/install).
</Note>

## Installationsmetoder

<Tip>
**Installationsscriptet** er den anbefalede måde at installere OpenClaw på. Det håndterer Node-detektion, installation og introduktion i ét trin.
</Tip>

<AccordionGroup>
  <Accordion title="Installationsscript" icon="rocket" defaultOpen>
    Downloader CLI’en, installerer den globalt via npm og starter introduktionsguiden.

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

    Det er det — scriptet håndterer Node-detektion, installation og introduktion.

    For at springe introduktionen over og kun installere binæren:

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

    For alle flag, miljøvariabler og CI/automationsmuligheder, se [Installer internals](/install/installer).

  </Accordion>

  <Accordion title="npm / pnpm" icon="package">
    Hvis du allerede har Node 22+ og foretrækker selv at styre installationen:

    <Tabs>
      <Tab title="npm">
        ```bash
        npm install -g openclaw@latest
        openclaw onboard --install-daemon
        ```

        <Accordion title="sharp build-fejl?">
          Hvis du har libvips installeret globalt (almindeligt på macOS via Homebrew) og `sharp` fejler, så gennemtving forbyggede binærer:

          ```bash
          SHARP_IGNORE_GLOBAL_LIBVIPS=1 npm install -g openclaw@latest
          ```

          Hvis du ser `sharp: Please add node-gyp to your dependencies`, skal du enten installere build-værktøjer (macOS: Xcode CLT + `npm install -g node-gyp`) eller bruge miljøvariablen ovenfor.
        </Accordion>
      </Tab>
      <Tab title="pnpm">
        ```bash
        pnpm add -g openclaw@latest
        pnpm approve-builds -g        # approve openclaw, node-llama-cpp, sharp, etc.
        openclaw onboard --install-daemon
        ```

        <Note>
        pnpm kræver eksplicit godkendelse af pakker med build-scripts. Når den første installation viser advarslen "Ignored build scripts", kør `pnpm approve-builds -g` og vælg de listede pakker.
        </Note>
      </Tab>
    </Tabs>

  </Accordion>

  <Accordion title="Fra kilde" icon="github">
    For bidragydere eller alle, der vil køre fra et lokalt checkout.

    <Steps>
      <Step title="Klon og byg">
        Klon [OpenClaw-repoet](https://github.com/openclaw/openclaw) og byg:

        ```bash
        git clone https://github.com/openclaw/openclaw.git
        cd openclaw
        pnpm install
        pnpm ui:build
        pnpm build
        ```
      </Step>
      <Step title="Link CLI’en">
        Gør `openclaw`-kommandoen tilgængelig globalt:

        ```bash
        pnpm link --global
        ```

        Alternativt kan du springe linket over og køre kommandoer via `pnpm openclaw ...` inde fra repoet.
      </Step>
      <Step title="Kør introduktion">
        ```bash
        openclaw onboard --install-daemon
        ```
      </Step>
    </Steps>

    For dybere udviklingsarbejdsgange, se [Opsætning](/start/setup).

  </Accordion>
</AccordionGroup>

## Andre installationsmetoder

<CardGroup cols={2}>
  <Card title="Docker" href="/install/docker" icon="container">
    Containeriserede eller headless-udrulninger.
  </Card>
  <Card title="Nix" href="/install/nix" icon="snowflake">
    Deklarativ installation via Nix.
  </Card>
  <Card title="Ansible" href="/install/ansible" icon="server">
    Automatiseret klargøring af flåder.
  </Card>
  <Card title="Bun" href="/install/bun" icon="zap">
    Kun-CLI-brug via Bun-runtime.
  </Card>
</CardGroup>

## Efter installation

Bekræft, at alt fungerer:

```bash
openclaw doctor         # check for config issues
openclaw status         # gateway status
openclaw dashboard      # open the browser UI
```

## Fejlfinding: `openclaw` ikke fundet

<Accordion title="PATH-diagnose og -rettelse">
  Hurtig diagnose:

```bash
node -v
npm -v
npm prefix -g
echo "$PATH"
```

Hvis `$(npm prefix -g)/bin` (macOS/Linux) eller `$(npm prefix -g)` (Windows) **ikke** er i din `$PATH`, kan din shell ikke finde globale npm-binærer (inklusive `openclaw`).

Rettelse — tilføj den til din shell-opstartsfil (`~/.zshrc` eller `~/.bashrc`):

```bash
export PATH="$(npm prefix -g)/bin:$PATH"
```

På Windows skal du tilføje outputtet af `npm prefix -g` til din PATH.

Åbn derefter en ny terminal (eller `rehash` i zsh / `hash -r` i bash).
</Accordion>

## Opdater / afinstaller

<CardGroup cols={3}>
  <Card title="Opdatering" href="/install/updating" icon="refresh-cw">
    Hold OpenClaw opdateret.
  </Card>
  <Card title="Migrering" href="/install/migrating" icon="arrow-right">
    Flyt til en ny maskine.
  </Card>
  <Card title="Afinstallér" href="/install/uninstall" icon="trash-2">
    Fjern OpenClaw helt.
  </Card>
</CardGroup>
