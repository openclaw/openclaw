---
summary: "CLI-Onboarding-Assistent: geführte Einrichtung für Gateway, Workspace, Kanäle und Skills"
read_when:
  - Beim Ausführen oder Konfigurieren des Onboarding-Assistenten
  - Beim Einrichten einer neuen Maschine
title: "Onboarding-Assistent (CLI)"
sidebarTitle: "Onboarding: CLI"
---

# Onboarding-Assistent (CLI)

Der Onboarding-Assistent ist der **empfohlene** Weg, um OpenClaw auf macOS,
Linux oder Windows (über WSL2; dringend empfohlen) einzurichten.
Er konfiguriert ein lokales Gateway oder eine entfernte Gateway-Verbindung sowie Kanäle, Skills
und Workspace-Standards in einem geführten Ablauf.

```bash
openclaw onboard
```

<Info>
Schnellster erster Chat: Öffnen Sie die Control UI (keine Kanal-Einrichtung erforderlich). Führen Sie
`openclaw dashboard` aus und chatten Sie im Browser. Doku: [Dashboard](/web/dashboard).
</Info>

So konfigurieren Sie später erneut:

```bash
openclaw configure
openclaw agents add <name>
```

<Note>
`--json` impliziert keinen nicht‑interaktiven Modus. Für Skripte verwenden Sie `--non-interactive`.
</Note>

<Tip>
Empfohlen: Richten Sie einen Brave-Search-API-Schlüssel ein, damit der Agent `web_search` verwenden kann
(`web_fetch` funktioniert ohne Schlüssel). Der einfachste Weg: `openclaw configure --section web`,
wodurch `tools.web.search.apiKey` gespeichert wird. Doku: [Web tools](/tools/web).
</Tip>

## Schnellstart vs. Erweitert

Der Assistent startet mit **Schnellstart** (Standards) vs. **Erweitert** (volle Kontrolle).

<Tabs>
  <Tab title="QuickStart (defaults)">
    - Lokales Gateway (loopback)
    - Workspace-Standard (oder bestehender Workspace)
    - Gateway-Port **18789**
    - Gateway-Authentifizierung **Token** (automatisch generiert, auch bei loopback)
    - Tailscale-Exponierung **Aus**
    - Telegram- und WhatsApp-Direktnachrichten standardmäßig auf **Allowlist** (Sie werden nach Ihrer Telefonnummer gefragt)
  </Tab>
  <Tab title="Advanced (full control)">
    - Legt jeden Schritt offen (Modus, Workspace, Gateway, Kanäle, Daemon, Skills).
  </Tab>
</Tabs>

## Was der Assistent konfiguriert

**Lokaler Modus (Standard)** führt Sie durch folgende Schritte:

1. **Modell/Auth** — Anthropic-API-Schlüssel (empfohlen), OAuth, OpenAI oder andere Anbieter. Wählen Sie ein Standardmodell.
2. **Workspace** — Speicherort für Agent-Dateien (Standard `~/.openclaw/workspace`). Initialisiert Bootstrap-Dateien.
3. **Gateway** — Port, Bind-Adresse, Authentifizierungsmodus, Tailscale-Exponierung.
4. **Kanäle** — WhatsApp, Telegram, Discord, Google Chat, Mattermost, Signal, BlueBubbles oder iMessage.
5. **Daemon** — Installiert einen LaunchAgent (macOS) oder eine systemd-Benutzereinheit (Linux/WSL2).
6. **Health-Check** — Startet das Gateway und überprüft, ob es läuft.
7. **Skills** — Installiert empfohlene Skills und optionale Abhängigkeiten.

<Note>
Ein erneutes Ausführen des Assistenten löscht **nichts**, es sei denn, Sie wählen ausdrücklich **Reset**
(oder übergeben `--reset`).
Wenn die Konfiguration ungültig ist oder veraltete Schlüssel enthält, fordert der Assistent Sie auf,
zuerst `openclaw doctor` auszuführen.
</Note>

Der **Remote-Modus** konfiguriert nur den lokalen Client für die Verbindung zu einem Gateway an einem anderen Ort.
Er installiert oder ändert **nichts** auf dem entfernten Host.

## Weiteren Agenten hinzufügen

Verwenden Sie `openclaw agents add <name>`, um einen separaten Agenten mit eigenem Workspace,
Sitzungen und Authentifizierungsprofilen zu erstellen. Das Ausführen ohne `--workspace` startet den Assistenten.

Was eingerichtet wird:

- `agents.list[].name`
- `agents.list[].workspace`
- `agents.list[].agentDir`

Hinweise:

- Standard-Workspaces folgen `~/.openclaw/workspace-<agentId>`.
- Fügen Sie `bindings` hinzu, um eingehende Nachrichten weiterzuleiten (der Assistent kann dies erledigen).
- Nicht‑interaktive Flags: `--model`, `--agent-dir`, `--bind`, `--non-interactive`.

## Vollständige Referenz

Für detaillierte Schritt‑für‑Schritt‑Aufschlüsselungen, nicht‑interaktives Scripting, Signal‑Einrichtung,
RPC-API und eine vollständige Liste der Konfigurationsfelder, die der Assistent schreibt, siehe die
[Wizard-Referenz](/reference/wizard).

## Verwandte Dokumente

- CLI-Befehlsreferenz: [`openclaw onboard`](/cli/onboard)
- macOS-App-Onboarding: [Onboarding](/start/onboarding)
- Agent-Erststart‑Ritual: [Agent Bootstrapping](/start/bootstrapping)
