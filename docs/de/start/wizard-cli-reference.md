---
summary: "„Vollständige Referenz für den CLI-Onboarding-Ablauf, die Authentifizierungs-/Modell-Einrichtung, Ausgaben und Interna“"
read_when:
  - Sie benötigen detailliertes Verhalten für openclaw onboard
  - Sie debuggen Onboarding-Ergebnisse oder integrieren Onboarding-Clients
title: "„CLI-Onboarding-Referenz“"
sidebarTitle: "„CLI-Referenz“"
---

# CLI-Onboarding-Referenz

Diese Seite ist die vollständige Referenz für `openclaw onboard`.
Eine kurze Anleitung finden Sie unter [Onboarding Wizard (CLI)](/start/wizard).

## Was der Assistent tut

Der lokale Modus (Standard) führt Sie durch:

- Modell- und Authentifizierungs-Setup (OpenAI Code-Abonnement OAuth, Anthropic API-Schlüssel oder Setup-Token sowie MiniMax-, GLM-, Moonshot- und AI-Gateway-Optionen)
- Workspace-Speicherort und Bootstrap-Dateien
- Gateway-Einstellungen (Port, Bind, Authentifizierung, Tailscale)
- Kanäle und Anbieter (Telegram, WhatsApp, Discord, Google Chat, Mattermost-Plugin, Signal)
- Daemon-Installation (LaunchAgent oder systemd-User-Unit)
- Gesundheitscheck
- Skills-Einrichtung

Der Remote-Modus konfiguriert diese Maschine so, dass sie sich mit einem Gateway an einem anderen Ort verbindet.
Er installiert oder verändert nichts auf dem Remote-Host.

## Details zum lokalen Ablauf

<Steps>
  <Step title="Existing config detection">
    - Wenn `~/.openclaw/openclaw.json` existiert, wählen Sie Behalten, Ändern oder Zurücksetzen.
    - Das erneute Ausführen des Assistenten löscht nichts, es sei denn, Sie wählen explizit Zurücksetzen (oder übergeben `--reset`).
    - Wenn die Konfiguration ungültig ist oder veraltete Schlüssel enthält, stoppt der Assistent und fordert Sie auf, vor dem Fortfahren `openclaw doctor` auszuführen.
    - Zurücksetzen verwendet `trash` und bietet folgende Umfänge:
      - Nur Konfiguration
      - Konfiguration + Anmeldedaten + Sitzungen
      - Vollständiges Zurücksetzen (entfernt auch den Workspace)  
</Step>
  <Step title="Model and auth">
    - Die vollständige Optionsmatrix finden Sie unter [Authentifizierungs- und Modelloptionen](#auth-and-model-options).
  </Step>
  <Step title="Workspace">
    - Standardmäßig `~/.openclaw/workspace` (konfigurierbar).
    - Erstellt die Workspace-Dateien, die für das Bootstrap-Ritual beim ersten Start benötigt werden.
    - Workspace-Layout: [Agent-Workspace](/concepts/agent-workspace).
  </Step>
  <Step title="Gateway">
    - Fragt Port, Bind, Authentifizierungsmodus und Tailscale-Exposition ab.
    - Empfehlung: Token-Authentifizierung auch für Loopback aktiviert lassen, damit lokale WS-Clients sich authentifizieren müssen.
    - Deaktivieren Sie die Authentifizierung nur, wenn Sie jedem lokalen Prozess vollständig vertrauen.
    - Nicht-Loopback-Binds erfordern weiterhin Authentifizierung.
  </Step>
  <Step title="Channels">
    - [WhatsApp](/channels/whatsapp): optionales QR-Login
    - [Telegram](/channels/telegram): Bot-Token
    - [Discord](/channels/discord): Bot-Token
    - [Google Chat](/channels/googlechat): Service-Account-JSON + Webhook-Zielgruppe
    - [Mattermost](/channels/mattermost)-Plugin: Bot-Token + Basis-URL
    - [Signal](/channels/signal): optionale Installation von `signal-cli` + Kontokonfiguration
    - [BlueBubbles](/channels/bluebubbles): empfohlen für iMessage; Server-URL + Passwort + Webhook
    - [iMessage](/channels/imessage): Legacy-`imsg`-CLI-Pfad + DB-Zugriff
    - DM-Sicherheit: Standard ist Pairing. Die erste Direktnachricht sendet einen Code; Genehmigung über
      `openclaw pairing approve <channel><code>` oder Verwendung von Allowlists.
  </Step><code>` oder Verwendung von Allowlists.
  </Step>
  <Step title="Daemon-Installation">
    - macOS: LaunchAgent
      - Erfordert eine angemeldete Benutzersitzung; für Headless-Betrieb verwenden Sie einen benutzerdefinierten LaunchDaemon (nicht enthalten).
    - Linux und Windows über WSL2: systemd-User-Unit
      - Der Assistent versucht `loginctl enable-linger <user>`, damit das Gateway nach dem Abmelden aktiv bleibt.
      - Möglicherweise wird sudo angefordert (schreibt `/var/lib/systemd/linger`); zunächst wird es ohne sudo versucht.
    - Laufzeitauswahl: Node (empfohlen; erforderlich für WhatsApp und Telegram). Bun wird nicht empfohlen.
  </Step>
  <Step title="Gesundheitscheck">
    - Startet das Gateway (falls erforderlich) und führt `openclaw health` aus.
    - `openclaw status --deep` fügt Gateway-Gesundheitsprüfungen zur Statusausgabe hinzu.
  </Step>
  <Step title="Skills">
    - Liest verfügbare Skills und prüft Anforderungen.
    - Ermöglicht die Auswahl des Node-Managers: npm oder pnpm (Bun wird nicht empfohlen).
    - Installiert optionale Abhängigkeiten (einige nutzen Homebrew unter macOS).
  </Step>
  <Step title="Abschluss">
    - Zusammenfassung und nächste Schritte, einschließlich Optionen für iOS-, Android- und macOS-Apps.
  </Step>
</Steps>

<Note>
Wenn keine GUI erkannt wird, gibt der Assistent Anweisungen für SSH-Portweiterleitung zur Control UI aus, anstatt einen Browser zu öffnen.
Wenn Control-UI-Assets fehlen, versucht der Assistent, sie zu bauen; der Fallback ist `pnpm ui:build` (installiert UI-Abhängigkeiten automatisch).
</Note>

## Details zum Remote-Modus

Der Remote-Modus konfiguriert diese Maschine so, dass sie sich mit einem Gateway an einem anderen Ort verbindet.

<Info>
Der Remote-Modus installiert oder verändert nichts auf dem Remote-Host.
</Info>

Was Sie festlegen:

- URL des Remote-Gateways (`ws://...`)
- Token, falls die Authentifizierung des Remote-Gateways erforderlich ist (empfohlen)

<Note>
- Wenn das Gateway nur über Loopback erreichbar ist, verwenden Sie SSH-Tunneling oder ein Tailnet.
- Discovery-Hinweise:
  - macOS: Bonjour (`dns-sd`)
  - Linux: Avahi (`avahi-browse`)
</Note>

## Authentifizierungs- und Modelloptionen

<AccordionGroup>
  <Accordion title="Anthropic API key (recommended)">
    Verwendet `ANTHROPIC_API_KEY`, falls vorhanden, oder fordert einen Schlüssel an und speichert ihn anschließend für den Daemon-Betrieb.
  </Accordion>
  <Accordion title="Anthropic OAuth (Claude Code CLI)">
    - macOS: prüft den Keychain-Eintrag „Claude Code-credentials“
    - Linux und Windows: verwendet `~/.claude/.credentials.json` erneut, falls vorhanden

    ```
    Wählen Sie unter macOS „Immer erlauben“, damit Startvorgänge über launchd nicht blockiert werden.
    ```

  </Accordion>
  <Accordion title="Anthropic token (setup-token paste)">
    Führen Sie `claude setup-token` auf einer beliebigen Maschine aus und fügen Sie anschließend das Token ein.
    Sie können es benennen; leer verwendet den Standard.
  </Accordion>
  <Accordion title="OpenAI Code subscription (Codex CLI reuse)">
    Wenn `~/.codex/auth.json` existiert, kann der Assistent es wiederverwenden.
  </Accordion>
  <Accordion title="OpenAI Code subscription (OAuth)">
    Browser-Ablauf; fügen Sie `code#state` ein.

    ```
    Setzt `agents.defaults.model` auf `openai-codex/gpt-5.3-codex`, wenn das Modell nicht gesetzt ist oder `openai/*`.
    ```

  </Accordion>
  <Accordion title="OpenAI API key">
    Verwendet `OPENAI_API_KEY`, falls vorhanden, oder fordert einen Schlüssel an und speichert ihn in
    `~/.openclaw/.env`, damit launchd ihn lesen kann.

    ```
    Setzt `agents.defaults.model` auf `openai/gpt-5.1-codex`, wenn das Modell nicht gesetzt ist, `openai/*` oder `openai-codex/*`.
    ```

  </Accordion>
  <Accordion title="xAI (Grok) API key">
    Fordert `XAI_API_KEY` an und konfiguriert xAI als Modellanbieter.
  </Accordion>
  <Accordion title="OpenCode Zen">
    Fordert `OPENCODE_API_KEY` (oder `OPENCODE_ZEN_API_KEY`) an.
    Setup-URL: [opencode.ai/auth](https://opencode.ai/auth).
  </Accordion>
  <Accordion title="API key (generic)">
    Speichert den Schlüssel für Sie.
  </Accordion>
  <Accordion title="Vercel AI Gateway">
    Fordert `AI_GATEWAY_API_KEY` an.
    Weitere Details: [Vercel AI Gateway](/providers/vercel-ai-gateway).
  </Accordion>
  <Accordion title="Cloudflare AI Gateway">
    Fordert Account-ID, Gateway-ID und `CLOUDFLARE_AI_GATEWAY_API_KEY` an.
    Weitere Details: [Cloudflare AI Gateway](/providers/cloudflare-ai-gateway).
  </Accordion>
  <Accordion title="MiniMax M2.1">
    Die Konfiguration wird automatisch geschrieben.
    Weitere Details: [MiniMax](/providers/minimax).
  </Accordion>
  <Accordion title="Synthetic (Anthropic-compatible)">
    Fordert `SYNTHETIC_API_KEY` an.
    Weitere Details: [Synthetic](/providers/synthetic).
  </Accordion>
  <Accordion title="Moonshot and Kimi Coding">
    Moonshot- (Kimi K2) und Kimi-Coding-Konfigurationen werden automatisch geschrieben.
    Weitere Details: [Moonshot AI (Kimi + Kimi Coding)](/providers/moonshot).
  </Accordion>
  <Accordion title="Skip">
    Lässt die Authentifizierung unkonfiguriert.
  </Accordion>
</AccordionGroup>

Modellverhalten:

- Auswahl eines Standardmodells aus erkannten Optionen oder manuelle Eingabe von Anbieter und Modell.
- Der Assistent führt eine Modellprüfung aus und warnt, wenn das konfigurierte Modell unbekannt ist oder die Authentifizierung fehlt.

Pfad für Anmeldedaten und Profile:

- OAuth-Anmeldedaten: `~/.openclaw/credentials/oauth.json`
- Authentifizierungsprofile (API-Schlüssel + OAuth): `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`

<Note>
Tipp für Headless- und Server-Betrieb: Schließen Sie OAuth auf einer Maschine mit Browser ab und kopieren Sie anschließend
`~/.openclaw/credentials/oauth.json` (oder `$OPENCLAW_STATE_DIR/credentials/oauth.json`)
auf den Gateway-Host.
</Note>

## Ausgaben und Interna

Typische Felder in `~/.openclaw/openclaw.json`:

- `agents.defaults.workspace`
- `agents.defaults.model` / `models.providers` (falls Minimax gewählt)
- `gateway.*` (Modus, Bind, Authentifizierung, Tailscale)
- `channels.telegram.botToken`, `channels.discord.token`, `channels.signal.*`, `channels.imessage.*`
- Kanal-Allowlisten (Slack, Discord, Matrix, Microsoft Teams), wenn Sie während der Abfragen zustimmen (Namen werden nach Möglichkeit zu IDs aufgelöst)
- `skills.install.nodeManager`
- `wizard.lastRunAt`
- `wizard.lastRunVersion`
- `wizard.lastRunCommit`
- `wizard.lastRunCommand`
- `wizard.lastRunMode`

`openclaw agents add` schreibt `agents.list[]` und optional `bindings`.

WhatsApp-Anmeldedaten liegen unter `~/.openclaw/credentials/whatsapp/<accountId>/`.
Sitzungen werden unter `~/.openclaw/agents/<agentId>/sessions/` gespeichert.

<Note>
Einige Kanäle werden als Plugins ausgeliefert. Wenn sie während des Onboardings ausgewählt werden, fordert der Assistent zur Installation des Plugins (npm oder lokaler Pfad) auf, bevor die Kanalkonfiguration erfolgt.
</Note>

Gateway-Assistent-RPC:

- `wizard.start`
- `wizard.next`
- `wizard.cancel`
- `wizard.status`

Clients (macOS-App und Control UI) können Schritte rendern, ohne die Onboarding-Logik neu zu implementieren.

Signal-Setup-Verhalten:

- Lädt das passende Release-Asset herunter
- Speichert es unter `~/.openclaw/tools/signal-cli/<version>/`
- Schreibt `channels.signal.cliPath` in die Konfiguration
- JVM-Builds erfordern Java 21
- Native Builds werden verwendet, wenn verfügbar
- Windows nutzt WSL2 und folgt dem Linux-signal-cli-Ablauf innerhalb von WSL

## Verwandte Dokumente

- Onboarding-Hub: [Onboarding Wizard (CLI)](/start/wizard)
- Automatisierung und Skripte: [CLI Automation](/start/wizard-cli-automation)
- Befehlsreferenz: [`openclaw onboard`](/cli/onboard)
