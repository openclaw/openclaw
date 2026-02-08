---
summary: "OpenClaw installieren — Installationsskript, npm/pnpm, aus dem Quellcode, Docker und mehr"
read_when:
  - Sie benötigen eine Installationsmethode außerhalb des Schnellstarts unter „Erste Schritte“
  - Sie möchten auf einer Cloud-Plattform bereitstellen
  - Sie müssen aktualisieren, migrieren oder deinstallieren
title: "Installation"
x-i18n:
  source_path: install/index.md
  source_hash: 67c029634ba38196
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:36:40Z
---

# Installation

Bereits [Erste Schritte](/start/getting-started) befolgt? Dann sind Sie startklar — diese Seite ist für alternative Installationsmethoden, plattformspezifische Anleitungen und Wartung.

## Systemanforderungen

- **[Node 22+](/install/node)** (das [Installationsskript](#install-methods) installiert es, falls es fehlt)
- macOS, Linux oder Windows
- `pnpm` nur, wenn Sie aus dem Quellcode bauen

<Note>
Unter Windows empfehlen wir dringend, OpenClaw unter [WSL2](https://learn.microsoft.com/en-us/windows/wsl/install) auszuführen.
</Note>

## Installationsmethoden

<Tip>
Das **Installationsskript** ist der empfohlene Weg zur Installation von OpenClaw. Es übernimmt Node-Erkennung, Installation und Onboarding in einem Schritt.
</Tip>

<AccordionGroup>
  <Accordion title="Installationsskript" icon="rocket" defaultOpen>
    Lädt die CLI herunter, installiert sie global über npm und startet den Onboarding-Assistenten.

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

    Das war’s — das Skript übernimmt Node-Erkennung, Installation und Onboarding.

    Um das Onboarding zu überspringen und nur das Binary zu installieren:

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

    Für alle Flags, Umgebungsvariablen und CI-/Automatisierungsoptionen siehe [Installer internals](/install/installer).

  </Accordion>

  <Accordion title="npm / pnpm" icon="package">
    Wenn Sie bereits Node 22+ haben und die Installation selbst verwalten möchten:

    <Tabs>
      <Tab title="npm">
        ```bash
        npm install -g openclaw@latest
        openclaw onboard --install-daemon
        ```

        <Accordion title="sharp-Buildfehler?">
          Wenn Sie libvips global installiert haben (auf macOS häufig über Homebrew) und `sharp` fehlschlägt, erzwingen Sie vorgefertigte Binaries:

          ```bash
          SHARP_IGNORE_GLOBAL_LIBVIPS=1 npm install -g openclaw@latest
          ```

          Wenn Sie `sharp: Please add node-gyp to your dependencies` sehen, installieren Sie entweder Build-Tooling (macOS: Xcode CLT + `npm install -g node-gyp`) oder verwenden Sie die oben genannte Umgebungsvariable.
        </Accordion>
      </Tab>
      <Tab title="pnpm">
        ```bash
        pnpm add -g openclaw@latest
        pnpm approve-builds -g        # approve openclaw, node-llama-cpp, sharp, etc.
        openclaw onboard --install-daemon
        ```

        <Note>
        pnpm erfordert eine explizite Genehmigung für Pakete mit Build-Skripten. Nachdem die erste Installation die Warnung „Ignored build scripts“ anzeigt, führen Sie `pnpm approve-builds -g` aus und wählen Sie die aufgeführten Pakete aus.
        </Note>
      </Tab>
    </Tabs>

  </Accordion>

  <Accordion title="Aus dem Quellcode" icon="github">
    Für Mitwirkende oder alle, die aus einem lokalen Checkout ausführen möchten.

    <Steps>
      <Step title="Klonen und bauen">
        Klonen Sie das [OpenClaw-Repo](https://github.com/openclaw/openclaw) und bauen Sie es:

        ```bash
        git clone https://github.com/openclaw/openclaw.git
        cd openclaw
        pnpm install
        pnpm ui:build
        pnpm build
        ```
      </Step>
      <Step title="CLI verlinken">
        Machen Sie den Befehl `openclaw` global verfügbar:

        ```bash
        pnpm link --global
        ```

        Alternativ überspringen Sie das Verlinken und führen Befehle über `pnpm openclaw ...` innerhalb des Repos aus.
      </Step>
      <Step title="Onboarding ausführen">
        ```bash
        openclaw onboard --install-daemon
        ```
      </Step>
    </Steps>

    Für vertiefte Entwicklungs-Workflows siehe [Setup](/start/setup).

  </Accordion>
</AccordionGroup>

## Weitere Installationsmethoden

<CardGroup cols={2}>
  <Card title="Docker" href="/install/docker" icon="container">
    Containerisierte oder headless Bereitstellungen.
  </Card>
  <Card title="Nix" href="/install/nix" icon="snowflake">
    Deklarative Installation über Nix.
  </Card>
  <Card title="Ansible" href="/install/ansible" icon="server">
    Automatisierte Bereitstellung von Flotten.
  </Card>
  <Card title="Bun" href="/install/bun" icon="zap">
    Reine CLI-Nutzung über die Bun-Runtime.
  </Card>
</CardGroup>

## Nach der Installation

Überprüfen Sie, ob alles funktioniert:

```bash
openclaw doctor         # check for config issues
openclaw status         # gateway status
openclaw dashboard      # open the browser UI
```

## Fehlerbehebung: `openclaw` nicht gefunden

<Accordion title="PATH-Diagnose und -Behebung">
  Schnelle Diagnose:

```bash
node -v
npm -v
npm prefix -g
echo "$PATH"
```

Wenn `$(npm prefix -g)/bin` (macOS/Linux) oder `$(npm prefix -g)` (Windows) **nicht** in Ihrem `$PATH` enthalten ist, kann Ihre Shell globale npm-Binaries (einschließlich `openclaw`) nicht finden.

Behebung — fügen Sie es Ihrer Shell-Startdatei hinzu (`~/.zshrc` oder `~/.bashrc`):

```bash
export PATH="$(npm prefix -g)/bin:$PATH"
```

Unter Windows fügen Sie die Ausgabe von `npm prefix -g` zu Ihrem PATH hinzu.

Öffnen Sie anschließend ein neues Terminal (oder `rehash` in zsh / `hash -r` in bash).
</Accordion>

## Aktualisieren / Deinstallieren

<CardGroup cols={3}>
  <Card title="Aktualisieren" href="/install/updating" icon="refresh-cw">
    Halten Sie OpenClaw auf dem neuesten Stand.
  </Card>
  <Card title="Migrieren" href="/install/migrating" icon="arrow-right">
    Wechseln Sie auf einen neuen Rechner.
  </Card>
  <Card title="Deinstallieren" href="/install/uninstall" icon="trash-2">
    Entfernen Sie OpenClaw vollständig.
  </Card>
</CardGroup>
