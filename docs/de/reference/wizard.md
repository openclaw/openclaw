---
summary: "Vollständige Referenz für den CLI-Onboarding-Assistenten: jeder Schritt, jede Flag und jedes Konfigurationsfeld"
read_when:
  - Nachschlagen eines bestimmten Assistenten-Schritts oder einer Flag
  - Automatisierung des Onboardings im nicht‑interaktiven Modus
  - Debugging des Assistenten-Verhaltens
title: "Onboarding-Assistent – Referenz"
sidebarTitle: "Wizard Reference"
---

# Onboarding-Assistent – Referenz

Dies ist die vollständige Referenz für den `openclaw onboard` CLI‑Assistenten.
Für einen Überblick auf hoher Ebene siehe [Onboarding Wizard](/start/wizard).

## Ablaufdetails (lokaler Modus)

<Steps>
  <Step title="Existing config detection">
    - Wenn `~/.openclaw/openclaw.json` existiert, wählen Sie **Behalten / Ändern / Zurücksetzen**.
    - Das erneute Ausführen des Assistenten löscht **nichts**, es sei denn, Sie wählen explizit **Zurücksetzen**
      (oder übergeben `--reset`).
    - Wenn die Konfiguration ungültig ist oder Legacy‑Keys enthält, stoppt der Assistent und fordert Sie auf,
      vor dem Fortfahren `openclaw doctor` auszuführen.
    - Zurücksetzen verwendet `trash` (niemals `rm`) und bietet Bereiche:
      - Nur Konfiguration
      - Konfiguration + Anmeldedaten + Sitzungen
      - Vollständiges Zurücksetzen (entfernt auch den Workspace)  
</Step>
  <Step title="Model/Auth">
    - **Anthropic API key (empfohlen)**: verwendet `ANTHROPIC_API_KEY`, falls vorhanden, oder fordert zur Eingabe eines Schlüssels auf und speichert ihn für den Daemon‑Betrieb.
    - **Anthropic OAuth (Claude Code CLI)**: unter macOS prüft der Assistent den Schlüsselbund‑Eintrag „Claude Code-credentials“ (wählen Sie „Always Allow“, damit launchd‑Starts nicht blockieren); unter Linux/Windows wird `~/.claude/.credentials.json` wiederverwendet, falls vorhanden.
    - **Anthropic token (setup-token einfügen)**: führen Sie `claude setup-token` auf einem beliebigen Rechner aus und fügen Sie dann den Token ein (Sie können ihn benennen; leer = Standard).
    - **OpenAI Code (Codex) subscription (Codex CLI)**: wenn `~/.codex/auth.json` existiert, kann der Assistent es wiederverwenden.
    - **OpenAI Code (Codex) subscription (OAuth)**: Browser‑Flow; fügen Sie `code#state` ein.
      - Setzt `agents.defaults.model` auf `openai-codex/gpt-5.2`, wenn kein Modell gesetzt ist oder `openai/*`.
    - **OpenAI API key**: verwendet `OPENAI_API_KEY`, falls vorhanden, oder fordert zur Eingabe eines Schlüssels auf und speichert ihn in `~/.openclaw/.env`, damit launchd ihn lesen kann.
    - **xAI (Grok) API key**: fordert `XAI_API_KEY` an und konfiguriert xAI als Modellanbieter.
    - **OpenCode Zen (Multi‑Modell‑Proxy)**: fordert `OPENCODE_API_KEY` an (oder `OPENCODE_ZEN_API_KEY`; erhältlich unter https://opencode.ai/auth).
    - **API key**: speichert den Schlüssel für Sie.
    - **Vercel AI Gateway (Multi‑Modell‑Proxy)**: fordert `AI_GATEWAY_API_KEY` an.
    - Mehr Details: [Vercel AI Gateway](/providers/vercel-ai-gateway)
    - **Cloudflare AI Gateway**: fordert Account ID, Gateway ID und `CLOUDFLARE_AI_GATEWAY_API_KEY` an.
    - Mehr Details: [Cloudflare AI Gateway](/providers/cloudflare-ai-gateway)
    - **MiniMax M2.1**: Konfiguration wird automatisch geschrieben.
    - Mehr Details: [MiniMax](/providers/minimax)
    - **Synthetic (Anthropic‑kompatibel)**: fordert `SYNTHETIC_API_KEY` an.
    - Mehr Details: [Synthetic](/providers/synthetic)
    - **Moonshot (Kimi K2)**: Konfiguration wird automatisch geschrieben.
    - **Kimi Coding**: Konfiguration wird automatisch geschrieben.
    - Mehr Details: [Moonshot AI (Kimi + Kimi Coding)](/providers/moonshot)
    - **Überspringen**: noch keine Authentifizierung konfiguriert.
    - Wählen Sie ein Standardmodell aus den erkannten Optionen (oder geben Sie Anbieter/Modell manuell ein).
    - Der Assistent führt eine Modellprüfung aus und warnt, wenn das konfigurierte Modell unbekannt ist oder Authentifizierung fehlt.
    - OAuth‑Anmeldedaten liegen in `~/.openclaw/credentials/oauth.json`; Auth‑Profile liegen in `~/.openclaw/agents/<agentId>/agent/auth-profiles.json` (API‑Schlüssel + OAuth).
    - Mehr Details: [/concepts/oauth](/concepts/oauth)    
<Note>
    Tipp für Headless/Server: Schließen Sie OAuth auf einem Rechner mit Browser ab und kopieren Sie dann
    `~/.openclaw/credentials/oauth.json` (oder `$OPENCLAW_STATE_DIR/credentials/oauth.json`) auf den
    Gateway-Host.
    </Note>
  </Step>
  <Step title="Workspace">
    - Standard: `~/.openclaw/workspace` (konfigurierbar).
    - Legt die Workspace‑Dateien an, die für das Agent‑Bootstrap‑Ritual benötigt werden.
    - Vollständiges Workspace‑Layout + Backup‑Leitfaden: [Agent workspace](/concepts/agent-workspace)  
</Step>
  <Step title="Gateway">
    - Port, Bind, Auth‑Modus, Tailscale‑Exposition.
    - Auth‑Empfehlung: **Token** auch für loopback beibehalten, damit lokale WS‑Clients sich authentifizieren müssen.
    - Deaktivieren Sie Auth nur, wenn Sie jedem lokalen Prozess vollständig vertrauen.
    - Nicht‑loopback‑Binds erfordern weiterhin Auth.
  </Step>
  <Step title="Channels">
    - [WhatsApp](/channels/whatsapp): optionaler QR‑Login.
    - [Telegram](/channels/telegram): Bot‑Token.
    - [Discord](/channels/discord): Bot‑Token.
    - [Google Chat](/channels/googlechat): Service‑Account‑JSON + Webhook‑Audience.
    - [Mattermost](/channels/mattermost) (Plugin): Bot‑Token + Basis‑URL.
    - [Signal](/channels/signal): optionale Installation von `signal-cli` + Account‑Konfiguration.
    - [BlueBubbles](/channels/bluebubbles): **empfohlen für iMessage**; Server‑URL + Passwort + Webhook.
    - [iMessage](/channels/imessage): Legacy‑`imsg`‑CLI‑Pfad + DB‑Zugriff.
    - DM‑Sicherheit: Standard ist Pairing. Die erste Direktnachricht sendet einen Code; genehmigen Sie über `openclaw pairing approve <channel><code>` oder verwenden Sie Allowlists.
  </Step><code>` oder verwenden Sie Allowlists.
  </Step>
  <Step title="Daemon‑Installation">
    - macOS: LaunchAgent
      - Erfordert eine angemeldete Benutzersitzung; für Headless verwenden Sie einen benutzerdefinierten LaunchDaemon (nicht ausgeliefert).
    - Linux (und Windows über WSL2): systemd‑User‑Unit
      - Der Assistent versucht, Lingering über `loginctl enable-linger <user>` zu aktivieren, damit der Gateway nach dem Logout weiterläuft.
      - Kann nach sudo fragen (schreibt `/var/lib/systemd/linger`); versucht es zunächst ohne sudo.
    - **Runtime‑Auswahl:** Node (empfohlen; erforderlich für WhatsApp/Telegram). Bun ist **nicht empfohlen**.
  </Step>
  <Step title="Health‑Check">
    - Startet den Gateway (falls nötig) und führt `openclaw health` aus.
    - Tipp: `openclaw status --deep` fügt Gateway‑Health‑Probes zur Statusausgabe hinzu (erfordert einen erreichbaren Gateway).
  </Step>
  <Step title="Skills (empfohlen)">
    - Liest die verfügbaren Skills und prüft Anforderungen.
    - Ermöglicht die Auswahl eines Node‑Managers: **npm / pnpm** (bun nicht empfohlen).
    - Installiert optionale Abhängigkeiten (einige verwenden Homebrew unter macOS).
  </Step>
  <Step title="Abschluss">
    - Zusammenfassung + nächste Schritte, einschließlich iOS/Android/macOS‑Apps für zusätzliche Funktionen.
  </Step>
</Steps>

<Note>
Wenn keine GUI erkannt wird, gibt der Assistent Anweisungen für SSH‑Port‑Forwarding zur Control UI aus, anstatt einen Browser zu öffnen.
Wenn die Assets der Control UI fehlen, versucht der Assistent, sie zu bauen; Fallback ist `pnpm ui:build` (installiert UI‑Abhängigkeiten automatisch).
</Note>

## Nicht‑interaktiver Modus

Verwenden Sie `--non-interactive`, um das Onboarding zu automatisieren oder zu skripten:

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice apiKey \
  --anthropic-api-key "$ANTHROPIC_API_KEY" \
  --gateway-port 18789 \
  --gateway-bind loopback \
  --install-daemon \
  --daemon-runtime node \
  --skip-skills
```

Fügen Sie `--json` für eine maschinenlesbare Zusammenfassung hinzu.

<Note>
`--json` impliziert **nicht** den nicht‑interaktiven Modus. Verwenden Sie `--non-interactive` (und `--workspace`) für Skripte.
</Note>

<AccordionGroup>
  <Accordion title="Gemini example">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice gemini-api-key \
      --gemini-api-key "$GEMINI_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Z.AI example">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice zai-api-key \
      --zai-api-key "$ZAI_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Vercel AI Gateway example">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice ai-gateway-api-key \
      --ai-gateway-api-key "$AI_GATEWAY_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Cloudflare AI Gateway example">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice cloudflare-ai-gateway-api-key \
      --cloudflare-ai-gateway-account-id "your-account-id" \
      --cloudflare-ai-gateway-gateway-id "your-gateway-id" \
      --cloudflare-ai-gateway-api-key "$CLOUDFLARE_AI_GATEWAY_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Moonshot example">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice moonshot-api-key \
      --moonshot-api-key "$MOONSHOT_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Synthetic example">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice synthetic-api-key \
      --synthetic-api-key "$SYNTHETIC_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="OpenCode Zen example">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice opencode-zen \
      --opencode-zen-api-key "$OPENCODE_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
</AccordionGroup>

### Agent hinzufügen (nicht‑interaktiv)

```bash
openclaw agents add work \
  --workspace ~/.openclaw/workspace-work \
  --model openai/gpt-5.2 \
  --bind whatsapp:biz \
  --non-interactive \
  --json
```

## Gateway‑Assistent‑RPC

Der Gateway stellt den Assistenten‑Ablauf über RPC bereit (`wizard.start`, `wizard.next`, `wizard.cancel`, `wizard.status`).
Clients (macOS‑App, Control UI) können Schritte rendern, ohne die Onboarding‑Logik neu zu implementieren.

## Signal‑Einrichtung (signal-cli)

Der Assistent kann `signal-cli` aus GitHub‑Releases installieren:

- Lädt das passende Release‑Asset herunter.
- Speichert es unter `~/.openclaw/tools/signal-cli/<version>/`.
- Schreibt `channels.signal.cliPath` in Ihre Konfiguration.

Hinweise:

- JVM‑Builds erfordern **Java 21**.
- Native Builds werden verwendet, wenn verfügbar.
- Windows verwendet WSL2; die Installation von signal-cli folgt dem Linux‑Ablauf innerhalb von WSL.

## Was der Assistent schreibt

Typische Felder in `~/.openclaw/openclaw.json`:

- `agents.defaults.workspace`
- `agents.defaults.model` / `models.providers` (wenn Minimax gewählt)
- `gateway.*` (Modus, Bind, Auth, Tailscale)
- `channels.telegram.botToken`, `channels.discord.token`, `channels.signal.*`, `channels.imessage.*`
- Kanal‑Allowlists (Slack/Discord/Matrix/Microsoft Teams), wenn Sie während der Abfragen zustimmen (Namen werden, wenn möglich, zu IDs aufgelöst).
- `skills.install.nodeManager`
- `wizard.lastRunAt`
- `wizard.lastRunVersion`
- `wizard.lastRunCommit`
- `wizard.lastRunCommand`
- `wizard.lastRunMode`

`openclaw agents add` schreibt `agents.list[]` und optional `bindings`.

WhatsApp‑Anmeldedaten liegen unter `~/.openclaw/credentials/whatsapp/<accountId>/`.
Sitzungen werden unter `~/.openclaw/agents/<agentId>/sessions/` gespeichert.

Einige Kanäle werden als Plugins ausgeliefert. Wenn Sie während des Onboardings eines auswählen, fordert der Assistent zur Installation auf (npm oder ein lokaler Pfad), bevor es konfiguriert werden kann.

## Verwandte Dokumente

- Assistent‑Überblick: [Onboarding Wizard](/start/wizard)
- macOS‑App‑Onboarding: [Onboarding](/start/onboarding)
- Konfigurationsreferenz: [Gateway configuration](/gateway/configuration)
- Anbieter: [WhatsApp](/channels/whatsapp), [Telegram](/channels/telegram), [Discord](/channels/discord), [Google Chat](/channels/googlechat), [Signal](/channels/signal), [BlueBubbles](/channels/bluebubbles) (iMessage), [iMessage](/channels/imessage) (Legacy)
- Skills: [Skills](/tools/skills), [Skills config](/tools/skills-config)
