---
summary: "OpenClaw installeren — installatiescript, npm/pnpm, vanaf de bron, Docker en meer"
read_when:
  - Je hebt een installatiemethode nodig anders dan de Aan de slag-snelstart
  - Je wilt implementeren op een cloudplatform
  - Je moet bijwerken, migreren of verwijderen
title: "Installeren"
---

# Installeren

Al [Aan de slag](/start/getting-started) gevolgd? Dan ben je klaar — deze pagina is voor alternatieve installatiemethoden, platformspecifieke instructies en onderhoud.

## Systeemvereisten

- **[Node 22+](/install/node)** (het [installatiescript](#install-methods) installeert dit indien nodig)
- macOS, Linux of Windows
- `pnpm` alleen als je vanaf de bron bouwt

<Note>
Op Windows raden we sterk aan OpenClaw onder [WSL2](https://learn.microsoft.com/en-us/windows/wsl/install) te draaien.
</Note>

## Installatiemethoden

<Tip>
Het **installatiescript** is de aanbevolen manier om OpenClaw te installeren. Het regelt Node-detectie, installatie en onboarding in één stap.
</Tip>

<AccordionGroup>
  <Accordion title="Installer script" icon="rocket" defaultOpen>
    Downloadt de CLI, installeert deze globaal via npm en start de onboarding-wizard.

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
    
    Dat is alles — het script regelt Node-detectie, installatie en onboarding.
    
    Om onboarding over te slaan en alleen het binaire bestand te installeren:
    
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
    
    Voor alle flags, omgevingsvariabelen en CI-/automatiseringsopties, zie [Installer internals](/install/installer).
    ```

  </Accordion>

  <Accordion title="npm / pnpm" icon="package">
    Als je Node 22+ al hebt en de installatie zelf wilt beheren:

    ```
    <Tabs>
      <Tab title="npm">
        ```bash
        npm install -g openclaw@latest
        openclaw onboard --install-daemon
        ```
    
        <Accordion title="sharp-buildfouten?">
          Als je libvips globaal hebt geïnstalleerd (gebruikelijk op macOS via Homebrew) en `sharp` faalt, forceer dan vooraf gebouwde binaries:
    
          ```bash
          SHARP_IGNORE_GLOBAL_LIBVIPS=1 npm install -g openclaw@latest
          ```
    
          Als je `sharp: Please add node-gyp to your dependencies` ziet, installeer dan build-tooling (macOS: Xcode CLT + `npm install -g node-gyp`) of gebruik de bovenstaande omgevingsvariabele.
        </Accordion>
      </Tab>
      <Tab title="pnpm">
        ```bash
        pnpm add -g openclaw@latest
        pnpm approve-builds -g        # approve openclaw, node-llama-cpp, sharp, etc.
        openclaw onboard --install-daemon
        ```
    
        <Note>
        pnpm vereist expliciete goedkeuring voor pakketten met build-scripts. Nadat de eerste installatie de waarschuwing "Ignored build scripts" toont, voer `pnpm approve-builds -g` uit en selecteer de vermelde pakketten.
        </Note>
      </Tab>
    </Tabs>
    ```

  </Accordion>

  <Accordion title="From source" icon="github">
    Voor bijdragers of iedereen die vanuit een lokale checkout wil draaien.

    ```
    <Steps>
      <Step title="Clonen en bouwen">
        Clone de [OpenClaw-repo](https://github.com/openclaw/openclaw) en bouw:
    
        ```bash
        git clone https://github.com/openclaw/openclaw.git
        cd openclaw
        pnpm install
        pnpm ui:build
        pnpm build
        ```
      </Step>
      <Step title="De CLI koppelen">
        Maak het `openclaw`-commando globaal beschikbaar:
    
        ```bash
        pnpm link --global
        ```
    
        Je kunt ook het koppelen overslaan en opdrachten uitvoeren via `pnpm openclaw ...` vanuit de repo.
      </Step>
      <Step title="Onboarding uitvoeren">
        ```bash
        openclaw onboard --install-daemon
        ```
      </Step>
    </Steps>
    
    Voor uitgebreidere ontwikkelworkflows, zie [Installatie](/start/setup).
    ```

  </Accordion>
</AccordionGroup>

## Andere installatiemethoden

<CardGroup cols={2}>
  <Card title="Docker" href="/install/docker" icon="container">
    Gecontaineriseerde of headless deployments.
  </Card>
  <Card title="Nix" href="/install/nix" icon="snowflake">
    Declaratieve installatie via Nix.
  </Card>
  <Card title="Ansible" href="/install/ansible" icon="server">
    Geautomatiseerde provisioning van fleets.
  </Card>
  <Card title="Bun" href="/install/bun" icon="zap">
    Alleen-CLI-gebruik via de Bun-runtime.
  </Card>
</CardGroup>

## Na installatie

Controleer of alles werkt:

```bash
openclaw doctor         # check for config issues
openclaw status         # gateway status
openclaw dashboard      # open the browser UI
```

## Problemen oplossen: `openclaw` niet gevonden

<Accordion title="PATH diagnosis and fix">
  Snelle diagnose:

```bash
node -v
npm -v
npm prefix -g
echo "$PATH"
```

Als `$(npm prefix -g)/bin` (macOS/Linux) of `$(npm prefix -g)` (Windows) **niet** in je `$PATH` staat, kan je shell globale npm-binaries (inclusief `openclaw`) niet vinden.

Oplossing — voeg het toe aan je shell-opstartbestand (`~/.zshrc` of `~/.bashrc`):

```bash
export PATH="$(npm prefix -g)/bin:$PATH"
```

Voeg op Windows de uitvoer van `npm prefix -g` toe aan je PATH.

Open daarna een nieuwe terminal (of `rehash` in zsh / `hash -r` in bash). </Accordion>

## Bijwerken / verwijderen

<CardGroup cols={3}>
  <Card title="Updating" href="/install/updating" icon="refresh-cw">
    Houd OpenClaw up-to-date.
  </Card>
  <Card title="Migrating" href="/install/migrating" icon="arrow-right">
    Verhuizen naar een nieuwe machine.
  </Card>
  <Card title="Uninstall" href="/install/uninstall" icon="trash-2">
    OpenClaw volledig verwijderen.
  </Card>
</CardGroup>
