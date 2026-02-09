---
summary: "Installera OpenClaw — installationsskript, npm/pnpm, från källkod, Docker och mer"
read_when:
  - Du behöver en installationsmetod utöver Snabbstart i Kom igång
  - Du vill distribuera till en molnplattform
  - Du behöver uppdatera, migrera eller avinstallera
title: "Installera"
---

# Installera

Redan följt [Komma igång](/start/getting-started)? Du är alla inställd — denna sida är för alternativa installationsmetoder, plattformsspecifika instruktioner och underhåll.

## Systemkrav

- **[Node 22+](/install/node)** (installationsskriptet [installer script](#install-methods) installerar det om det saknas)
- macOS, Linux eller Windows
- `pnpm` endast om du bygger från källkod

<Note>
På Windows rekommenderar vi starkt att köra OpenClaw under [WSL2](https://learn.microsoft.com/en-us/windows/wsl/install).
</Note>

## Installationsmetoder

<Tip>
**installationsskript** är det rekommenderade sättet att installera OpenClaw. Den hanterar noddetektering, installation och onboarding i ett steg.
</Tip>

<AccordionGroup>
  <Accordion title="Installer script" icon="rocket" defaultOpen>
    Hämtar CLI:t, installerar det globalt via npm och startar introduktionsguiden.

    ```
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
    
    Klart — skriptet hanterar Node-detektering, installation och introduktion.
    
    För att hoppa över introduktionen och bara installera binären:
    
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
    
    För alla flaggor, miljövariabler och CI-/automationsalternativ, se [Installer internals](/install/installer).
    ```

  </Accordion>

  <Accordion title="npm / pnpm" icon="package">
    Om du redan har Node 22+ och föredrar att hantera installationen själv:

    ```
    <Tabs>
      <Tab title="npm">
        ```bash
        npm install -g openclaw@latest
        openclaw onboard --install-daemon
        ```
    
        <Accordion title="sharp-byggfel?">
          Om du har libvips installerat globalt (vanligt på macOS via Homebrew) och `sharp` misslyckas, tvinga förbyggda binärer:
    
          ```bash
          SHARP_IGNORE_GLOBAL_LIBVIPS=1 npm install -g openclaw@latest
          ```
    
          Om du ser `sharp: Please add node-gyp to your dependencies`, installera antingen byggverktyg (macOS: Xcode CLT + `npm install -g node-gyp`) eller använd miljövariabeln ovan.
        </Accordion>
      </Tab>
      <Tab title="pnpm">
        ```bash
        pnpm add -g openclaw@latest
        pnpm approve-builds -g        # approve openclaw, node-llama-cpp, sharp, etc.
        openclaw onboard --install-daemon
        ```
    
        <Note>
        pnpm kräver uttryckligt godkännande för paket med byggskript. Efter att den första installationen visar varningen ”Ignored build scripts”, kör `pnpm approve-builds -g` och välj de listade paketen.
        </Note>
      </Tab>
    </Tabs>
    ```

  </Accordion>

  <Accordion title="From source" icon="github">
    För bidragsgivare eller alla som vill köra från en lokal utcheckning.

    ```
    <Steps>
      <Step title="Klona och bygg">
        Klona [OpenClaw-repot](https://github.com/openclaw/openclaw) och bygg:
    
        ```bash
        git clone https://github.com/openclaw/openclaw.git
        cd openclaw
        pnpm install
        pnpm ui:build
        pnpm build
        ```
      </Step>
      <Step title="Länka CLI:t">
        Gör kommandot `openclaw` tillgängligt globalt:
    
        ```bash
        pnpm link --global
        ```
    
        Alternativt kan du hoppa över länkningen och köra kommandon via `pnpm openclaw ...` inifrån repot.
      </Step>
      <Step title="Kör introduktionen">
        ```bash
        openclaw onboard --install-daemon
        ```
      </Step>
    </Steps>
    
    För djupare utvecklingsarbetsflöden, se [Konfigurering](/start/setup).
    ```

  </Accordion>
</AccordionGroup>

## Andra installationsmetoder

<CardGroup cols={2}>
  <Card title="Docker" href="/install/docker" icon="container">
    Containeriserade eller headless-distributioner.
  </Card>
  <Card title="Nix" href="/install/nix" icon="snowflake">
    Deklarativ installation via Nix.
  </Card>
  <Card title="Ansible" href="/install/ansible" icon="server">
    Automatiserad provisionering av flottor.
  </Card>
  <Card title="Bun" href="/install/bun" icon="zap">
    Endast CLI-användning via Bun-runtime.
  </Card>
</CardGroup>

## Efter installation

Verifiera att allt fungerar:

```bash
openclaw doctor         # check for config issues
openclaw status         # gateway status
openclaw dashboard      # open the browser UI
```

## Felsökning: `openclaw` hittades inte

<Accordion title="PATH diagnosis and fix">
  Snabb diagnos:

```bash
node -v
npm -v
npm prefix -g
echo "$PATH"
```

Om `$(npm prefix -g)/bin` (macOS/Linux) eller `$(npm prefix -g)` (Windows) **inte** finns i din `$PATH`, kan ditt skal inte hitta globala npm-binärer (inklusive `openclaw`).

Åtgärd — lägg till den i din skals startfil (`~/.zshrc` eller `~/.bashrc`):

```bash
export PATH="$(npm prefix -g)/bin:$PATH"
```

På Windows, lägg till utdata från `npm prefix -g` i din PATH.

Öppna sedan en ny terminal (eller `rehash` i zsh / `hash -r` i bash). </Accordion>

## Uppdatera / avinstallera

<CardGroup cols={3}>
  <Card title="Updating" href="/install/updating" icon="refresh-cw">
    Håll OpenClaw uppdaterat.
  </Card>
  <Card title="Migrating" href="/install/migrating" icon="arrow-right">
    Flytta till en ny maskin.
  </Card>
  <Card title="Uninstall" href="/install/uninstall" icon="trash-2">
    Ta bort OpenClaw helt.
  </Card>
</CardGroup>
