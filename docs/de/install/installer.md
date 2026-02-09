---
summary: "Wie die Installationsskripte funktionieren (install.sh, install-cli.sh, install.ps1), Flags und Automatisierung"
read_when:
  - Sie möchten `openclaw.ai/install.sh` verstehen
  - Sie möchten Installationen automatisieren (CI / headless)
  - Sie möchten aus einem GitHub-Checkout installieren
title: "Installer-Interna"
---

# Installer-Interna

OpenClaw liefert drei Installationsskripte aus, bereitgestellt unter `openclaw.ai`.

| Skript                             | Plattform                               | Was es tut                                                                                                                                            |
| ---------------------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`install.sh`](#installsh)         | macOS / Linux / WSL                     | Installiert Node bei Bedarf, installiert OpenClaw via npm (Standard) oder Git und kann Onboarding ausführen.       |
| [`install-cli.sh`](#install-clish) | macOS / Linux / WSL                     | Installiert Node + OpenClaw in ein lokales Präfix (`~/.openclaw`). Keine Root-Rechte erforderlich. |
| [`install.ps1`](#installps1)       | Windows (PowerShell) | Installiert Node bei Bedarf, installiert OpenClaw via npm (Standard) oder Git und kann Onboarding ausführen.       |

## Schnellbefehle

<Tabs>
  <Tab title="install.sh">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash
    ```

    ````
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --help
    ```
    ````

  </Tab>
  <Tab title="install-cli.sh">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash
    ```

    ````
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash -s -- --help
    ```
    ````

  </Tab>
  <Tab title="install.ps1">
    ```powershell
    iwr -useb https://openclaw.ai/install.ps1 | iex
    ```

    ````
    ```powershell
    & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -Tag beta -NoOnboard -DryRun
    ```
    ````

  </Tab>
</Tabs>

<Note>
Wenn die Installation erfolgreich ist, aber `openclaw` in einem neuen Terminal nicht gefunden wird, siehe [Node.js-Fehlerbehebung](/install/node#troubleshooting).
</Note>

---

## install.sh

<Tip>
Empfohlen für die meisten interaktiven Installationen auf macOS/Linux/WSL.
</Tip>

### Ablauf (install.sh)

<Steps>
  <Step title="Detect OS">
    Unterstützt macOS und Linux (einschließlich WSL). Wenn macOS erkannt wird, wird Homebrew installiert, falls es fehlt.
  </Step>
  <Step title="Ensure Node.js 22+">
    Prüft die Node-Version und installiert bei Bedarf Node 22 (Homebrew auf macOS, NodeSource-Setup-Skripte auf Linux apt/dnf/yum).
  </Step>
  <Step title="Ensure Git">
    Installiert Git, falls es fehlt.
  </Step>
  <Step title="Install OpenClaw">
    - `npm`-Methode (Standard): globale npm-Installation
    - `git`-Methode: Repository klonen/aktualisieren, Abhängigkeiten mit pnpm installieren, bauen und anschließend Wrapper unter `~/.local/bin/openclaw` installieren
  </Step>
  <Step title="Post-install tasks">
    - Führt `openclaw doctor --non-interactive` bei Upgrades und Git-Installationen aus (Best Effort)
    - Versucht Onboarding auszuführen, wenn geeignet (TTY verfügbar, Onboarding nicht deaktiviert und Bootstrap-/Konfigurationsprüfungen bestehen)
    - Standardmäßig `SHARP_IGNORE_GLOBAL_LIBVIPS=1`
  </Step>
</Steps>

### Erkennung eines Source-Checkouts

Wenn das Skript innerhalb eines OpenClaw-Checkouts ausgeführt wird (`package.json` + `pnpm-workspace.yaml`), bietet es an:

- Checkout verwenden (`git`), oder
- globale Installation verwenden (`npm`)

Wenn kein TTY verfügbar ist und keine Installationsmethode gesetzt ist, wird standardmäßig `npm` verwendet und eine Warnung ausgegeben.

Das Skript beendet sich mit Code `2` bei ungültiger Methodenauswahl oder ungültigen `--install-method`-Werten.

### Beispiele (install.sh)

<Tabs>
  <Tab title="Default">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash
    ```
  </Tab>
  <Tab title="Skip onboarding">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --no-onboard
    ```
  </Tab>
  <Tab title="Git install">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --install-method git
    ```
  </Tab>
  <Tab title="Dry run">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --dry-run
    ```
  </Tab>
</Tabs>

<AccordionGroup>
  <Accordion title="Flags reference">

| Flag                              | Beschreibung                                                                                                                        |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `--install-method npm\\|git`     | Installationsmethode wählen (Standard: `npm`). Alias: `--method` |
| `--npm`                           | Kurzform für die npm-Methode                                                                                                        |
| `--git`                           | Kurzform für die Git-Methode. Alias: `--github`                                                     |
| `--version <version\\|dist-tag>` | npm-Version oder Dist-Tag (Standard: `latest`)                                                   |
| `--beta`                          | Beta-Dist-Tag verwenden, falls verfügbar, sonst Fallback auf `latest`                                                               |
| `--git-dir <path>`                | Checkout-Verzeichnis (Standard: `~/openclaw`). Alias: `--dir`    |
| `--no-git-update`                 | `git pull` für bestehenden Checkout überspringen                                                                                    |
| `--no-prompt`                     | Prompts deaktivieren                                                                                                                |
| `--no-onboard`                    | Onboarding überspringen                                                                                                             |
| `--onboard`                       | Onboarding aktivieren                                                                                                               |
| `--dry-run`                       | Aktionen ausgeben, ohne Änderungen anzuwenden                                                                                       |
| `--verbose`                       | Debug-Ausgabe aktivieren (`set -x`, npm-Logs auf Notice-Level)                                                   |
| `--help`                          | Usage anzeigen (`-h`)                                                                                            |

  </Accordion>

  <Accordion title="Environment variables reference">

| Variable                                        | Beschreibung                                                                           |
| ----------------------------------------------- | -------------------------------------------------------------------------------------- |
| `OPENCLAW_INSTALL_METHOD=git\\|npm`            | Installationsmethode                                                                   |
| `OPENCLAW_VERSION=latest\\|next\\|<semver>`   | npm-Version oder Dist-Tag                                                              |
| `OPENCLAW_BETA=0\\|1`                          | Beta verwenden, falls verfügbar                                                        |
| `OPENCLAW_GIT_DIR=<path>`                       | Checkout-Verzeichnis                                                                   |
| `OPENCLAW_GIT_UPDATE=0\\|1`                    | Git-Updates umschalten                                                                 |
| `OPENCLAW_NO_PROMPT=1`                          | Prompts deaktivieren                                                                   |
| `OPENCLAW_NO_ONBOARD=1`                         | Onboarding überspringen                                                                |
| `OPENCLAW_DRY_RUN=1`                            | Dry-Run-Modus                                                                          |
| `OPENCLAW_VERBOSE=1`                            | Debug-Modus                                                                            |
| `OPENCLAW_NPM_LOGLEVEL=error\\|warn\\|notice` | npm-Log-Level                                                                          |
| `SHARP_IGNORE_GLOBAL_LIBVIPS=0\\|1`            | Verhalten von sharp/libvips steuern (Standard: `1`) |

  </Accordion>
</AccordionGroup>

---

## install-cli.sh

<Info>
Entwickelt für Umgebungen, in denen alles unter einem lokalen Präfix liegen soll (Standard `~/.openclaw`) und keine systemweite Node-Abhängigkeit gewünscht ist.
</Info>

### Ablauf (install-cli.sh)

<Steps>
  <Step title="Install local Node runtime">
    Lädt das Node-Tarball (Standard `22.22.0`) nach `<prefix>/tools/node-v<version>` herunter und verifiziert SHA-256.
  </Step>
  <Step title="Ensure Git">
    Falls Git fehlt, wird versucht, es unter Linux via apt/dnf/yum oder unter macOS via Homebrew zu installieren.
  </Step>
  <Step title="Install OpenClaw under prefix">
    Installiert mit npm unter Verwendung von `--prefix <prefix>` und schreibt anschließend den Wrapper nach `<prefix>/bin/openclaw`.
  </Step>
</Steps>

### Beispiele (install-cli.sh)

<Tabs>
  <Tab title="Default">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash
    ```
  </Tab>
  <Tab title="Custom prefix + version">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash -s -- --prefix /opt/openclaw --version latest
    ```
  </Tab>
  <Tab title="Automation JSON output">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash -s -- --json --prefix /opt/openclaw
    ```
  </Tab>
  <Tab title="Run onboarding">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash -s -- --onboard
    ```
  </Tab>
</Tabs>

<AccordionGroup>
  <Accordion title="Flags reference">

| Flag                   | Beschreibung                                                                                          |
| ---------------------- | ----------------------------------------------------------------------------------------------------- |
| `--prefix <path>`      | Installationspräfix (Standard: `~/.openclaw`)                      |
| `--version <ver>`      | OpenClaw-Version oder Dist-Tag (Standard: `latest`)                |
| `--node-version <ver>` | Node-Version (Standard: `22.22.0`)                                 |
| `--json`               | NDJSON-Events ausgeben                                                                                |
| `--onboard`            | `openclaw onboard` nach der Installation ausführen                                                    |
| `--no-onboard`         | Onboarding überspringen (Standard)                                                 |
| `--set-npm-prefix`     | Unter Linux npm-Präfix auf `~/.npm-global` erzwingen, wenn das aktuelle Präfix nicht beschreibbar ist |
| `--help`               | Usage anzeigen (`-h`)                                                              |

  </Accordion>

  <Accordion title="Environment variables reference">

| Variable                                        | Beschreibung                                                                                               |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `OPENCLAW_PREFIX=<path>`                        | Installationspräfix                                                                                        |
| `OPENCLAW_VERSION=<ver>`                        | OpenClaw-Version oder Dist-Tag                                                                             |
| `OPENCLAW_NODE_VERSION=<ver>`                   | Node-Version                                                                                               |
| `OPENCLAW_NO_ONBOARD=1`                         | Onboarding überspringen                                                                                    |
| `OPENCLAW_NPM_LOGLEVEL=error\\|warn\\|notice` | npm-Log-Level                                                                                              |
| `OPENCLAW_GIT_DIR=<path>`                       | Legacy-Cleanup-Suchpfad (verwendet beim Entfernen alter `Peekaboo`-Submodule-Checkouts) |
| `SHARP_IGNORE_GLOBAL_LIBVIPS=0\\|1`            | Verhalten von sharp/libvips steuern (Standard: `1`)                     |

  </Accordion>
</AccordionGroup>

---

## install.ps1

### Ablauf (install.ps1)

<Steps>
  <Step title="Ensure PowerShell + Windows environment">
    Erfordert PowerShell 5+.
  </Step>
  <Step title="Ensure Node.js 22+">
    Falls fehlend, wird eine Installation über winget, dann Chocolatey und anschließend Scoop versucht.
  </Step>
  <Step title="Install OpenClaw">
    - `npm`-Methode (Standard): globale npm-Installation mit dem ausgewählten `-Tag`
    - `git`-Methode: Repository klonen/aktualisieren, mit pnpm installieren/bauen und Wrapper unter `%USERPROFILE%\.local\bin\openclaw.cmd` installieren
  </Step>
  <Step title="Post-install tasks">
    Fügt nach Möglichkeit das benötigte bin-Verzeichnis zum Benutzer-PATH hinzu und führt anschließend `openclaw doctor --non-interactive` bei Upgrades und Git-Installationen aus (Best Effort).
  </Step>
</Steps>

### Beispiele (install.ps1)

<Tabs>
  <Tab title="Default">
    ```powershell
    iwr -useb https://openclaw.ai/install.ps1 | iex
    ```
  </Tab>
  <Tab title="Git install">
    ```powershell
    & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -InstallMethod git
    ```
  </Tab>
  <Tab title="Custom git directory">
    ```powershell
    & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -InstallMethod git -GitDir "C:\openclaw"
    ```
  </Tab>
  <Tab title="Dry run">
    ```powershell
    & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -DryRun
    ```
  </Tab>
</Tabs>

<AccordionGroup>
  <Accordion title="Flags reference">

| Flag                        | Beschreibung                                                                                  |
| --------------------------- | --------------------------------------------------------------------------------------------- |
| `-InstallMethod npm\\|git` | Installationsmethode (Standard: `npm`)                     |
| `-Tag <tag>`                | npm-Dist-Tag (Standard: `latest`)                          |
| `-GitDir <path>`            | Checkout-Verzeichnis (Standard: `%USERPROFILE%\openclaw`) |
| `-NoOnboard`                | Onboarding überspringen                                                                       |
| `-NoGitUpdate`              | `git pull` überspringen                                                                       |
| `-DryRun`                   | Nur Aktionen ausgeben                                                                         |

  </Accordion>

  <Accordion title="Environment variables reference">

| Variable                             | Beschreibung            |
| ------------------------------------ | ----------------------- |
| `OPENCLAW_INSTALL_METHOD=git\\|npm` | Installationsmethode    |
| `OPENCLAW_GIT_DIR=<path>`            | Checkout-Verzeichnis    |
| `OPENCLAW_NO_ONBOARD=1`              | Onboarding überspringen |
| `OPENCLAW_GIT_UPDATE=0`              | Git-Pull deaktivieren   |
| `OPENCLAW_DRY_RUN=1`                 | Dry-Run-Modus           |

  </Accordion>
</AccordionGroup>

<Note>
Wenn `-InstallMethod git` verwendet wird und Git fehlt, beendet sich das Skript und gibt den Link zu Git für Windows aus.
</Note>

---

## CI und Automatisierung

Verwenden Sie nicht-interaktive Flags/Umgebungsvariablen für vorhersehbare Läufe.

<Tabs>
  <Tab title="install.sh (non-interactive npm)">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --no-prompt --no-onboard
    ```
  </Tab>
  <Tab title="install.sh (non-interactive git)">
    ```bash
    OPENCLAW_INSTALL_METHOD=git OPENCLAW_NO_PROMPT=1 \
      curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash
    ```
  </Tab>
  <Tab title="install-cli.sh (JSON)">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash -s -- --json --prefix /opt/openclaw
    ```
  </Tab>
  <Tab title="install.ps1 (skip onboarding)">
    ```powershell
    & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -NoOnboard
    ```
  </Tab>
</Tabs>

---

## Fehlerbehebung

<AccordionGroup>
  <Accordion title="Why is Git required?">
    Git ist für die `git`-Installationsmethode erforderlich. Für `npm`-Installationen wird Git weiterhin geprüft/installiert, um `spawn git ENOENT`-Fehler zu vermeiden, wenn Abhängigkeiten Git-URLs verwenden.
  </Accordion>

  <Accordion title="Why does npm hit EACCES on Linux?">
    Einige Linux-Setups verweisen das globale npm-Präfix auf root-eigene Pfade. `install.sh` kann das Präfix auf `~/.npm-global` umstellen und PATH-Exports an Shell-rc-Dateien anhängen (sofern diese Dateien existieren).
  </Accordion>

  <Accordion title="sharp/libvips issues">
    Die Skripte setzen standardmäßig `SHARP_IGNORE_GLOBAL_LIBVIPS=1`, um zu vermeiden, dass sharp gegen systemweites libvips baut. Zum Überschreiben:

    ````
    ```bash
    SHARP_IGNORE_GLOBAL_LIBVIPS=0 curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash
    ```
    ````

  </Accordion>

  <Accordion title='Windows: "npm error spawn git / ENOENT"'>
    Installieren Sie Git für Windows, öffnen Sie PowerShell erneut und führen Sie den Installer erneut aus.
  </Accordion>

  <Accordion title='Windows: "openclaw is not recognized"'>
    Führen Sie `npm config get prefix` aus, hängen Sie `\bin` an, fügen Sie dieses Verzeichnis zum Benutzer-PATH hinzu und öffnen Sie PowerShell erneut.
  </Accordion>

  <Accordion title="openclaw not found after install">
    In der Regel ein PATH-Problem. Siehe [Node.js-Fehlerbehebung](/install/node#troubleshooting).
  </Accordion>
</AccordionGroup>
