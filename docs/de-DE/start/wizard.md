---
summary: "CLI-Onboarding-Wizard: geführtes Setup für Gateway, Workspace, Channels und Skills"
read_when:
  - Onboarding-Wizard ausführen oder konfigurieren
  - Neue Maschine einrichten
title: "Onboarding-Wizard (CLI)"
sidebarTitle: "Onboarding: CLI"
---

# Onboarding-Wizard (CLI)

Der Onboarding-Wizard ist der **empfohlene** Weg, OpenClaw auf macOS,
Linux oder Windows (via WSL2, dringend empfohlen) einzurichten.
Er konfiguriert ein lokales Gateway oder eine Remote-Gateway-Verbindung sowie Channels, Skills
und Workspace-Defaults in einem geführten Ablauf.

```bash
openclaw onboard
```

<Info>
Schnellster erster Chat: Control UI öffnen, ohne Channel-Setup. Führe
`openclaw dashboard` aus und chatte im Browser. Doku: [Dashboard](/web/dashboard).
</Info>

Später neu konfigurieren:

```bash
openclaw configure
openclaw agents add <name>
```

<Note>
`--json` bedeutet nicht automatisch den nicht interaktiven Modus. Für Skripte nutze `--non-interactive`.
</Note>

<Tip>
Empfohlen: Richte einen Brave Search API-Key ein, damit der Agent `web_search` nutzen kann
(`web_fetch` funktioniert ohne Key). Der einfachste Weg ist `openclaw configure --section web`,
welches `tools.web.search.apiKey` speichert. Doku: [Web tools](/tools/web).
</Tip>

## QuickStart vs Advanced

Der Wizard startet mit **QuickStart** (Defaults) oder **Advanced** (volle Kontrolle).

<Tabs>
  <Tab title="QuickStart (Defaults)">
    - Lokales Gateway (Loopback)
    - Workspace-Default (oder vorhandener Workspace)
    - Gateway-Port **18789**
    - Gateway-Auth **Token** (automatisch generiert, auch bei Loopback)
    - Tailscale-Exposure **Off**
    - Telegram- und WhatsApp-DMs standardmäßig **Allowlist** (du wirst nach deiner Telefonnummer gefragt)
  </Tab>
  <Tab title="Advanced (volle Kontrolle)">
    - Zeigt alle Schritte an (Modus, Workspace, Gateway, Channels, Daemon, Skills).
  </Tab>
</Tabs>

## Was der Wizard konfiguriert

**Lokaler Modus (Default)** führt dich durch diese Schritte:

1. **Model/Auth** — Anthropic API-Key (empfohlen), OpenAI oder Custom Provider
   (OpenAI-kompatibel, Anthropic-kompatibel oder Unknown Auto-Detect). Wähle ein Standardmodell.
2. **Workspace** — Ort für Agent-Dateien (Default `~/.openclaw/workspace`). Legt Bootstrap-Dateien an.
3. **Gateway** — Port, Bind-Adresse, Auth-Modus, Tailscale-Exposure.
4. **Channels** — WhatsApp, Telegram, Discord, Google Chat, Mattermost, Signal, BlueBubbles oder iMessage.
5. **Daemon** — Installiert einen LaunchAgent (macOS) oder eine systemd-User-Unit (Linux/WSL2).
6. **Health Check** — Startet das Gateway und prüft, ob es läuft.
7. **Skills** — Installiert empfohlene Skills und optionale Abhängigkeiten.

<Note>
Ein erneuter Wizard-Lauf löscht **nichts**, außer du wählst explizit **Reset** (oder nutzt `--reset`).
Wenn die Konfiguration ungültig ist oder Legacy-Keys enthält, bittet der Wizard dich, zuerst `openclaw doctor` auszuführen.
</Note>

**Remote-Modus** konfiguriert nur den lokalen Client, um sich mit einem Gateway an anderer Stelle zu verbinden.
Er installiert oder ändert **nichts** auf dem Remote-Host.

## Einen weiteren Agenten hinzufügen

Nutze `openclaw agents add <name>`, um einen separaten Agenten mit eigenem Workspace,
Sessions und Auth-Profilen zu erstellen. Ohne `--workspace` startet der Wizard.

Was gesetzt wird:

- `agents.list[].name`
- `agents.list[].workspace`
- `agents.list[].agentDir`

Hinweise:

- Standard-Workspaces folgen `~/.openclaw/workspace-<agentId>`.
- Füge `bindings` hinzu, um eingehende Nachrichten zu routen (der Wizard kann das).
- Nicht interaktive Flags: `--model`, `--agent-dir`, `--bind`, `--non-interactive`.

## Vollständige Referenz

Für detaillierte Schritt-für-Schritt-Anleitungen, nicht interaktives Scripting, Signal-Setup,
RPC-API und die vollständige Liste der Config-Felder, die der Wizard schreibt, siehe die
[Wizard-Referenz](/reference/wizard).

## Verwandte Doku

- CLI-Befehlsreferenz: [`openclaw onboard`](/cli/onboard)
- Onboarding-Übersicht: [Onboarding Overview](/start/onboarding-overview)
- macOS-App-Onboarding: [Onboarding](/start/onboarding)
- Agent First-Run-Ritual: [Agent Bootstrapping](/start/bootstrapping)
