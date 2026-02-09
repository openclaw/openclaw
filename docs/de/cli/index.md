---
summary: "OpenClaw-CLI-Referenz für `openclaw`-Befehle, Unterbefehle und Optionen"
read_when:
  - Beim Hinzufügen oder Ändern von CLI-Befehlen oder -Optionen
  - Beim Dokumentieren neuer Befehlsoberflächen
title: "CLI-Referenz"
---

# CLI-Referenz

Diese Seite beschreibt das aktuelle CLI-Verhalten. Wenn sich Befehle ändern, aktualisieren Sie dieses Dokument.

## Befehlsseiten

- [`setup`](/cli/setup)
- [`onboard`](/cli/onboard)
- [`configure`](/cli/configure)
- [`config`](/cli/config)
- [`doctor`](/cli/doctor)
- [`dashboard`](/cli/dashboard)
- [`reset`](/cli/reset)
- [`uninstall`](/cli/uninstall)
- [`update`](/cli/update)
- [`message`](/cli/message)
- [`agent`](/cli/agent)
- [`agents`](/cli/agents)
- [`acp`](/cli/acp)
- [`status`](/cli/status)
- [`health`](/cli/health)
- [`sessions`](/cli/sessions)
- [`gateway`](/cli/gateway)
- [`logs`](/cli/logs)
- [`system`](/cli/system)
- [`models`](/cli/models)
- [`memory`](/cli/memory)
- [`nodes`](/cli/nodes)
- [`devices`](/cli/devices)
- [`node`](/cli/node)
- [`approvals`](/cli/approvals)
- [`sandbox`](/cli/sandbox)
- [`tui`](/cli/tui)
- [`browser`](/cli/browser)
- [`cron`](/cli/cron)
- [`dns`](/cli/dns)
- [`docs`](/cli/docs)
- [`hooks`](/cli/hooks)
- [`webhooks`](/cli/webhooks)
- [`pairing`](/cli/pairing)
- [`plugins`](/cli/plugins) (Plugin-Befehle)
- [`channels`](/cli/channels)
- [`security`](/cli/security)
- [`skills`](/cli/skills)
- [`voicecall`](/cli/voicecall) (Plugin; falls installiert)

## Globale Flags

- `--dev`: Zustand unter `~/.openclaw-dev` isolieren und Standardports verschieben.
- `--profile <name>`: Zustand unter `~/.openclaw-<name>` isolieren.
- `--no-color`: ANSI-Farben deaktivieren.
- `--update`: Kurzform für `openclaw update` (nur Quellinstallationen).
- `-V`, `--version`, `-v`: Version ausgeben und beenden.

## Ausgabestil

- ANSI-Farben und Fortschrittsanzeigen werden nur in TTY-Sitzungen gerendert.
- OSC-8-Hyperlinks werden in unterstützten Terminals als klickbare Links dargestellt; andernfalls greifen wir auf einfache URLs zurück.
- `--json` (und `--plain` wo unterstützt) deaktiviert das Styling für saubere Ausgaben.
- `--no-color` deaktiviert ANSI-Styling; `NO_COLOR=1` wird ebenfalls berücksichtigt.
- Lang laufende Befehle zeigen einen Fortschrittsindikator (OSC 9;4, wenn unterstützt).

## Farbpalette

OpenClaw verwendet für die CLI-Ausgabe eine „Lobster“-Palette.

- `accent` (#FF5A2D): Überschriften, Labels, primäre Hervorhebungen.
- `accentBright` (#FF7A3D): Befehlsnamen, Hervorhebungen.
- `accentDim` (#D14A22): sekundärer Hervorhebungstext.
- `info` (#FF8A5B): informative Werte.
- `success` (#2FBF71): Erfolgszustände.
- `warn` (#FFB020): Warnungen, Fallbacks, Aufmerksamkeit.
- `error` (#E23D2D): Fehler, Fehlschläge.
- `muted` (#8B7F77): Abschwächung, Metadaten.

Quelle der Wahrheit für die Palette: `src/terminal/palette.ts` (auch „lobster seam“).

## Befehlsbaum

```
openclaw [--dev] [--profile <name>] <command>
  setup
  onboard
  configure
  config
    get
    set
    unset
  doctor
  security
    audit
  reset
  uninstall
  update
  channels
    list
    status
    logs
    add
    remove
    login
    logout
  skills
    list
    info
    check
  plugins
    list
    info
    install
    enable
    disable
    doctor
  memory
    status
    index
    search
  message
  agent
  agents
    list
    add
    delete
  acp
  status
  health
  sessions
  gateway
    call
    health
    status
    probe
    discover
    install
    uninstall
    start
    stop
    restart
    run
  logs
  system
    event
    heartbeat last|enable|disable
    presence
  models
    list
    status
    set
    set-image
    aliases list|add|remove
    fallbacks list|add|remove|clear
    image-fallbacks list|add|remove|clear
    scan
    auth add|setup-token|paste-token
    auth order get|set|clear
  sandbox
    list
    recreate
    explain
  cron
    status
    list
    add
    edit
    rm
    enable
    disable
    runs
    run
  nodes
  devices
  node
    run
    status
    install
    uninstall
    start
    stop
    restart
  approvals
    get
    set
    allowlist add|remove
  browser
    status
    start
    stop
    reset-profile
    tabs
    open
    focus
    close
    profiles
    create-profile
    delete-profile
    screenshot
    snapshot
    navigate
    resize
    click
    type
    press
    hover
    drag
    select
    upload
    fill
    dialog
    wait
    evaluate
    console
    pdf
  hooks
    list
    info
    check
    enable
    disable
    install
    update
  webhooks
    gmail setup|run
  pairing
    list
    approve
  docs
  dns
    setup
  tui
```

Hinweis: Plugins können zusätzliche Top-Level-Befehle hinzufügen (zum Beispiel `openclaw voicecall`).

## Sicherheit

- `openclaw security audit` — prüft Konfiguration + lokalen Zustand auf gängige Sicherheits-Fallstricke.
- `openclaw security audit --deep` — Best‑Effort‑Live‑Probe des Gateways.
- `openclaw security audit --fix` — verschärft sichere Standardwerte und setzt chmod für Zustand/Konfiguration.

## Plugins

Verwalten Sie Erweiterungen und deren Konfiguration:

- `openclaw plugins list` — Plugins entdecken (verwenden Sie `--json` für maschinenlesbare Ausgabe).
- `openclaw plugins info <id>` — Details zu einem Plugin anzeigen.
- `openclaw plugins install <path|.tgz|npm-spec>` — Plugin installieren (oder einen Plugin-Pfad zu `plugins.load.paths` hinzufügen).
- `openclaw plugins enable <id>` / `disable <id>` — `plugins.entries.<id>.enabled` umschalten.
- `openclaw plugins doctor` — Fehler beim Laden von Plugins melden.

Die meisten Plugin-Änderungen erfordern einen Gateway-Neustart. Siehe [/plugin](/tools/plugin).

## Speicher

Vektorsuche über `MEMORY.md` + `memory/*.md`:

- `openclaw memory status` — Indexstatistiken anzeigen.
- `openclaw memory index` — Speicherdateien neu indexieren.
- `openclaw memory search "<query>"` — semantische Suche über den Speicher.

## Chat-Slash-Befehle

Chat-Nachrichten unterstützen `/...`‑Befehle (Text und nativ). Siehe [/tools/slash-commands](/tools/slash-commands).

Highlights:

- `/status` für schnelle Diagnosen.
- `/config` für persistente Konfigurationsänderungen.
- `/debug` für reine Laufzeit-Overrides der Konfiguration (Speicher, nicht Festplatte; erfordert `commands.debug: true`).

## Setup + Onboarding

### `setup`

Initialisiert Konfiguration + Workspace.

Optionen:

- `--workspace <dir>`: Agent-Workspace-Pfad (Standard `~/.openclaw/workspace`).
- `--wizard`: Onboarding-Assistent ausführen.
- `--non-interactive`: Assistent ohne Eingabeaufforderungen ausführen.
- `--mode <local|remote>`: Assistentenmodus.
- `--remote-url <url>`: Remote-Gateway-URL.
- `--remote-token <token>`: Remote-Gateway-Token.

Der Assistent startet automatisch, wenn eines der Assistenten-Flags vorhanden ist (`--non-interactive`, `--mode`, `--remote-url`, `--remote-token`).

### `onboard`

Interaktiver Assistent zum Einrichten von Gateway, Workspace und Skills.

Optionen:

- `--workspace <dir>`
- `--reset` (setzt Konfiguration + Anmeldedaten + Sitzungen + Workspace vor dem Assistenten zurück)
- `--non-interactive`
- `--mode <local|remote>`
- `--flow <quickstart|advanced|manual>` (manual ist ein Alias für advanced)
- `--auth-choice <setup-token|token|chutes|openai-codex|openai-api-key|openrouter-api-key|ai-gateway-api-key|moonshot-api-key|moonshot-api-key-cn|kimi-code-api-key|synthetic-api-key|venice-api-key|gemini-api-key|zai-api-key|apiKey|minimax-api|minimax-api-lightning|opencode-zen|skip>`
- `--token-provider <id>` (nicht interaktiv; verwendet mit `--auth-choice token`)
- `--token <token>` (nicht interaktiv; verwendet mit `--auth-choice token`)
- `--token-profile-id <id>` (nicht interaktiv; Standard: `<provider>:manual`)
- `--token-expires-in <duration>` (nicht interaktiv; z. B. `365d`, `12h`)
- `--anthropic-api-key <key>`
- `--openai-api-key <key>`
- `--openrouter-api-key <key>`
- `--ai-gateway-api-key <key>`
- `--moonshot-api-key <key>`
- `--kimi-code-api-key <key>`
- `--gemini-api-key <key>`
- `--zai-api-key <key>`
- `--minimax-api-key <key>`
- `--opencode-zen-api-key <key>`
- `--gateway-port <port>`
- `--gateway-bind <loopback|lan|tailnet|auto|custom>`
- `--gateway-auth <token|password>`
- `--gateway-token <token>`
- `--gateway-password <password>`
- `--remote-url <url>`
- `--remote-token <token>`
- `--tailscale <off|serve|funnel>`
- `--tailscale-reset-on-exit`
- `--install-daemon`
- `--no-install-daemon` (Alias: `--skip-daemon`)
- `--daemon-runtime <node|bun>`
- `--skip-channels`
- `--skip-skills`
- `--skip-health`
- `--skip-ui`
- `--node-manager <npm|pnpm|bun>` (pnpm empfohlen; bun nicht empfohlen für den Gateway‑Runtime)
- `--json`

### `configure`

Interaktiver Konfigurationsassistent (Modelle, Kanäle, Skills, Gateway).

### `config`

Nicht-interaktive Konfigurationshelfer (get/set/unset). Das Ausführen von `openclaw config` ohne
Unterbefehl startet den Assistenten.

Unterbefehle:

- `config get <path>`: einen Konfigurationswert ausgeben (Punkt-/Klammerpfad).
- `config set <path> <value>`: einen Wert setzen (JSON5 oder Rohstring).
- `config unset <path>`: einen Wert entfernen.

### `doctor`

Gesundheitschecks + schnelle Korrekturen (Konfiguration + Gateway + Legacy-Dienste).

Optionen:

- `--no-workspace-suggestions`: Workspace‑Speicherhinweise deaktivieren.
- `--yes`: Standardwerte ohne Nachfrage akzeptieren (headless).
- `--non-interactive`: Eingabeaufforderungen überspringen; nur sichere Migrationen anwenden.
- `--deep`: Systemdienste nach zusätzlichen Gateway-Installationen scannen.

## Kanalhelfer

### `channels`

Verwalten Sie Chat-Kanal-Konten (WhatsApp/Telegram/Discord/Google Chat/Slack/Mattermost (Plugin)/Signal/iMessage/MS Teams).

Unterbefehle:

- `channels list`: konfigurierte Kanäle und Auth-Profile anzeigen.
- `channels status`: Gateway-Erreichbarkeit und Kanalzustand prüfen (`--probe` führt zusätzliche Prüfungen aus; verwenden Sie `openclaw health` oder `openclaw status --deep` für Gateway‑Health‑Probes).
- Tipp: `channels status` gibt Warnungen mit vorgeschlagenen Korrekturen aus, wenn gängige Fehlkonfigurationen erkannt werden (und verweist dann auf `openclaw doctor`).
- `channels logs`: aktuelle Kanallogs aus der Gateway‑Logdatei anzeigen.
- `channels add`: Assistentenartiges Setup ohne Flags; Flags schalten in den nicht‑interaktiven Modus.
- `channels remove`: standardmäßig deaktivieren; übergeben Sie `--delete`, um Konfigurationseinträge ohne Nachfrage zu entfernen.
- `channels login`: interaktiver Kanal‑Login (nur WhatsApp Web).
- `channels logout`: von einer Kanalsitzung abmelden (falls unterstützt).

Häufige Optionen:

- `--channel <name>`: `whatsapp|telegram|discord|googlechat|slack|mattermost|signal|imessage|msteams`
- `--account <id>`: Kanal‑Konto‑ID (Standard `default`)
- `--name <label>`: Anzeigename für das Konto

`channels login`‑Optionen:

- `--channel <channel>` (Standard `whatsapp`; unterstützt `whatsapp`/`web`)
- `--account <id>`
- `--verbose`

`channels logout`‑Optionen:

- `--channel <channel>` (Standard `whatsapp`)
- `--account <id>`

`channels list`‑Optionen:

- `--no-usage`: Nutzung/Quota‑Snapshots des Modellanbieters überspringen (nur OAuth/API‑basiert).
- `--json`: JSON ausgeben (enthält Nutzung, sofern `--no-usage` nicht gesetzt ist).

`channels logs`‑Optionen:

- `--channel <name|all>` (Standard `all`)
- `--lines <n>` (Standard `200`)
- `--json`

Mehr Details: [/concepts/oauth](/concepts/oauth)

Beispiele:

```bash
openclaw channels add --channel telegram --account alerts --name "Alerts Bot" --token $TELEGRAM_BOT_TOKEN
openclaw channels add --channel discord --account work --name "Work Bot" --token $DISCORD_BOT_TOKEN
openclaw channels remove --channel discord --account work --delete
openclaw channels status --probe
openclaw status --deep
```

### `skills`

Verfügbare Skills auflisten und prüfen, einschließlich Bereitschaftsinformationen.

Unterbefehle:

- `skills list`: Skills auflisten (Standard, wenn kein Unterbefehl).
- `skills info <name>`: Details zu einem Skill anzeigen.
- `skills check`: Zusammenfassung „bereit vs. fehlende Anforderungen“.

Optionen:

- `--eligible`: nur bereite Skills anzeigen.
- `--json`: JSON ausgeben (ohne Styling).
- `-v`, `--verbose`: Details zu fehlenden Anforderungen einbeziehen.

Tipp: Verwenden Sie `npx clawhub`, um Skills zu suchen, zu installieren und zu synchronisieren.

### `pairing`

DM‑Pairing‑Anfragen kanalübergreifend genehmigen.

Unterbefehle:

- `pairing list <channel> [--json]`
- `pairing approve <channel> <code> [--notify]`

### `webhooks gmail`

Gmail‑Pub/Sub‑Hook‑Setup + Runner. Siehe [/automation/gmail-pubsub](/automation/gmail-pubsub).

Unterbefehle:

- `webhooks gmail setup` (erfordert `--account <email>`; unterstützt `--project`, `--topic`, `--subscription`, `--label`, `--hook-url`, `--hook-token`, `--push-token`, `--bind`, `--port`, `--path`, `--include-body`, `--max-bytes`, `--renew-minutes`, `--tailscale`, `--tailscale-path`, `--tailscale-target`, `--push-endpoint`, `--json`)
- `webhooks gmail run` (Laufzeit‑Overrides für dieselben Flags)

### `dns setup`

DNS‑Helfer für Weitbereichs‑Discovery (CoreDNS + Tailscale). Siehe [/gateway/discovery](/gateway/discovery).

Optionen:

- `--apply`: CoreDNS‑Konfiguration installieren/aktualisieren (erfordert sudo; nur macOS).

## Messaging + Agent

### `message`

Vereinheitlichte ausgehende Nachrichten + Kanalaktionen.

Siehe: [/cli/message](/cli/message)

Unterbefehle:

- `message send|poll|react|reactions|read|edit|delete|pin|unpin|pins|permissions|search|timeout|kick|ban`
- `message thread <create|list|reply>`
- `message emoji <list|upload>`
- `message sticker <send|upload>`
- `message role <info|add|remove>`
- `message channel <info|list>`
- `message member info`
- `message voice status`
- `message event <list|create>`

Beispiele:

- `openclaw message send --target +15555550123 --message "Hi"`
- `openclaw message poll --channel discord --target channel:123 --poll-question "Snack?" --poll-option Pizza --poll-option Sushi`

### `agent`

Einen Agent‑Turn über das Gateway ausführen (oder `--local` eingebettet).

Erforderlich:

- `--message <text>`

Optionen:

- `--to <dest>` (für Sitzungsschlüssel und optionale Zustellung)
- `--session-id <id>`
- `--thinking <off|minimal|low|medium|high|xhigh>` (nur GPT‑5.2‑ und Codex‑Modelle)
- `--verbose <on|full|off>`
- `--channel <whatsapp|telegram|discord|slack|mattermost|signal|imessage|msteams>`
- `--local`
- `--deliver`
- `--json`
- `--timeout <seconds>`

### `agents`

Isolierte Agenten verwalten (Workspaces + Auth + Routing).

#### `agents list`

Konfigurierte Agenten auflisten.

Optionen:

- `--json`
- `--bindings`

#### `agents add [name]`

Einen neuen isolierten Agenten hinzufügen. Startet den geführten Assistenten, sofern keine Flags (oder `--non-interactive`) übergeben werden; `--workspace` ist im nicht‑interaktiven Modus erforderlich.

Optionen:

- `--workspace <dir>`
- `--model <id>`
- `--agent-dir <dir>`
- `--bind <channel[:accountId]>` (wiederholbar)
- `--non-interactive`
- `--json`

Bindungsspezifikationen verwenden `channel[:accountId]`. Wenn `accountId` für WhatsApp weggelassen wird, wird die Standard‑Konto‑ID verwendet.

#### `agents delete <id>`

Einen Agenten löschen und seinen Workspace + Zustand bereinigen.

Optionen:

- `--force`
- `--json`

### `acp`

Die ACP‑Bridge ausführen, die IDEs mit dem Gateway verbindet.

Siehe [`acp`](/cli/acp) für vollständige Optionen und Beispiele.

### `status`

Verknüpfte Sitzungszustände und aktuelle Empfänger anzeigen.

Optionen:

- `--json`
- `--all` (vollständige Diagnose; schreibgeschützt, zum Einfügen geeignet)
- `--deep` (Kanäle prüfen)
- `--usage` (Nutzung/Quota des Modellanbieters anzeigen)
- `--timeout <ms>`
- `--verbose`
- `--debug` (Alias für `--verbose`)

Hinweise:

- Die Übersicht enthält – sofern verfügbar – den Status von Gateway und Node‑Host‑Dienst.

### Nutzungsverfolgung

OpenClaw kann Nutzung/Quota von Anbietern anzeigen, wenn OAuth/API‑Anmeldedaten verfügbar sind.

Oberflächen:

- `/status` (fügt, wenn verfügbar, eine kurze Anbieter‑Nutzungszeile hinzu)
- `openclaw status --usage` (gibt eine vollständige Anbieter‑Aufschlüsselung aus)
- macOS‑Menüleiste (Abschnitt „Usage“ unter „Context“)

Hinweise:

- Die Daten stammen direkt von den Usage‑Endpunkten der Anbieter (keine Schätzungen).
- Anbieter: Anthropic, GitHub Copilot, OpenAI Codex OAuth sowie Gemini CLI/Antigravity, wenn die entsprechenden Anbieter‑Plugins aktiviert sind.
- Wenn keine passenden Anmeldedaten vorhanden sind, wird die Nutzung ausgeblendet.
- Details: siehe [Usage tracking](/concepts/usage-tracking).

### `health`

Gesundheitsstatus vom laufenden Gateway abrufen.

Optionen:

- `--json`
- `--timeout <ms>`
- `--verbose`

### `sessions`

Gespeicherte Konversationssitzungen auflisten.

Optionen:

- `--json`
- `--verbose`
- `--store <path>`
- `--active <minutes>`

## Zurücksetzen / Deinstallieren

### `reset`

Lokale Konfiguration/Zustand zurücksetzen (CLI bleibt installiert).

Optionen:

- `--scope <config|config+creds+sessions|full>`
- `--yes`
- `--non-interactive`
- `--dry-run`

Hinweise:

- `--non-interactive` erfordert `--scope` und `--yes`.

### `uninstall`

Gateway‑Dienst + lokale Daten deinstallieren (CLI bleibt).

Optionen:

- `--service`
- `--state`
- `--workspace`
- `--app`
- `--all`
- `--yes`
- `--non-interactive`
- `--dry-run`

Hinweise:

- `--non-interactive` erfordert `--yes` und explizite Scopes (oder `--all`).

## Gateway

### `gateway`

Den WebSocket‑Gateway ausführen.

Optionen:

- `--port <port>`
- `--bind <loopback|tailnet|lan|auto|custom>`
- `--token <token>`
- `--auth <token|password>`
- `--password <password>`
- `--tailscale <off|serve|funnel>`
- `--tailscale-reset-on-exit`
- `--allow-unconfigured`
- `--dev`
- `--reset` (Dev‑Konfiguration + Anmeldedaten + Sitzungen + Workspace zurücksetzen)
- `--force` (bestehenden Listener auf dem Port beenden)
- `--verbose`
- `--claude-cli-logs`
- `--ws-log <auto|full|compact>`
- `--compact` (Alias für `--ws-log compact`)
- `--raw-stream`
- `--raw-stream-path <path>`

### `gateway service`

Gateway‑Dienst verwalten (launchd/systemd/schtasks).

Unterbefehle:

- `gateway status` (prüft standardmäßig das Gateway‑RPC)
- `gateway install` (Dienstinstallation)
- `gateway uninstall`
- `gateway start`
- `gateway stop`
- `gateway restart`

Hinweise:

- `gateway status` prüft standardmäßig das Gateway‑RPC mit dem vom Dienst aufgelösten Port/Konfiguration (überschreiben mit `--url/--token/--password`).
- `gateway status` unterstützt `--no-probe`, `--deep` und `--json` für Skripting.
- `gateway status` zeigt außerdem Legacy‑ oder zusätzliche Gateway‑Dienste an, wenn sie erkannt werden können (`--deep` fügt System‑Scans hinzu). Profilbenannte OpenClaw‑Dienste werden als erstklassig behandelt und nicht als „extra“ markiert.
- `gateway status` gibt aus, welchen Konfigurationspfad die CLI verwendet vs. welche Konfiguration der Dienst wahrscheinlich nutzt (Service‑Env), plus die aufgelöste Probe‑Ziel‑URL.
- `gateway install|uninstall|start|stop|restart` unterstützt `--json` für Skripting (Standardausgabe bleibt menschenfreundlich).
- `gateway install` verwendet standardmäßig die Node‑Runtime; bun ist **nicht empfohlen** (WhatsApp/Telegram‑Bugs).
- `gateway install`‑Optionen: `--port`, `--runtime`, `--token`, `--force`, `--json`.

### `logs`

Gateway‑Dateilogs per RPC verfolgen.

Hinweise:

- TTY‑Sitzungen rendern eine farbige, strukturierte Ansicht; Nicht‑TTY fällt auf Klartext zurück.
- `--json` gibt zeilenweise JSON aus (ein Log‑Ereignis pro Zeile).

Beispiele:

```bash
openclaw logs --follow
openclaw logs --limit 200
openclaw logs --plain
openclaw logs --json
openclaw logs --no-color
```

### `gateway <subcommand>`

Gateway‑CLI‑Hilfen (verwenden Sie `--url`, `--token`, `--password`, `--timeout`, `--expect-final` für RPC‑Unterbefehle).
Wenn Sie `--url` übergeben, wendet die CLI Konfiguration oder Umgebungs‑Anmeldedaten nicht automatisch an.
Schließen Sie `--token` oder `--password` explizit ein. Fehlende explizite Anmeldedaten sind ein Fehler.

Unterbefehle:

- `gateway call <method> [--params <json>]`
- `gateway health`
- `gateway status`
- `gateway probe`
- `gateway discover`
- `gateway install|uninstall|start|stop|restart`
- `gateway run`

Häufige RPCs:

- `config.apply` (validieren + Konfiguration schreiben + Neustart + Aufwecken)
- `config.patch` (partielles Update zusammenführen + Neustart + Aufwecken)
- `update.run` (Update ausführen + Neustart + Aufwecken)

Tipp: Wenn Sie `config.set`/`config.apply`/`config.patch` direkt aufrufen, übergeben Sie `baseHash` aus
`config.get`, falls bereits eine Konfiguration existiert.

## Modelle

Siehe [/concepts/models](/concepts/models) für Fallback‑Verhalten und Scan‑Strategie.

Bevorzugte Anthropic‑Auth (Setup‑Token):

```bash
claude setup-token
openclaw models auth setup-token --provider anthropic
openclaw models status
```

### `models` (Root)

`openclaw models` ist ein Alias für `models status`.

Root‑Optionen:

- `--status-json` (Alias für `models status --json`)
- `--status-plain` (Alias für `models status --plain`)

### `models list`

Optionen:

- `--all`
- `--local`
- `--provider <name>`
- `--json`
- `--plain`

### `models status`

Optionen:

- `--json`
- `--plain`
- `--check` (Exit 1=abgelaufen/fehlend, 2=läuft ab)
- `--probe` (Live‑Probe der konfigurierten Auth‑Profile)
- `--probe-provider <name>`
- `--probe-profile <id>` (wiederholt oder kommagetrennt)
- `--probe-timeout <ms>`
- `--probe-concurrency <n>`
- `--probe-max-tokens <n>`

Enthält immer die Auth‑Übersicht und den OAuth‑Ablaufstatus für Profile im Auth‑Store.
`--probe` führt Live‑Anfragen aus (kann Tokens verbrauchen und Rate‑Limits auslösen).

### `models set <model>`

`agents.defaults.model.primary` setzen.

### `models set-image <model>`

`agents.defaults.imageModel.primary` setzen.

### `models aliases list|add|remove`

Optionen:

- `list`: `--json`, `--plain`
- `add <alias> <model>`
- `remove <alias>`

### `models fallbacks list|add|remove|clear`

Optionen:

- `list`: `--json`, `--plain`
- `add <model>`
- `remove <model>`
- `clear`

### `models image-fallbacks list|add|remove|clear`

Optionen:

- `list`: `--json`, `--plain`
- `add <model>`
- `remove <model>`
- `clear`

### `models scan`

Optionen:

- `--min-params <b>`
- `--max-age-days <days>`
- `--provider <name>`
- `--max-candidates <n>`
- `--timeout <ms>`
- `--concurrency <n>`
- `--no-probe`
- `--yes`
- `--no-input`
- `--set-default`
- `--set-image`
- `--json`

### `models auth add|setup-token|paste-token`

Optionen:

- `add`: interaktiver Auth‑Helfer
- `setup-token`: `--provider <name>` (Standard `anthropic`), `--yes`
- `paste-token`: `--provider <name>`, `--profile-id <id>`, `--expires-in <duration>`

### `models auth order get|set|clear`

Optionen:

- `get`: `--provider <name>`, `--agent <id>`, `--json`
- `set`: `--provider <name>`, `--agent <id>`, `<profileIds...>`
- `clear`: `--provider <name>`, `--agent <id>`

## System

### `system event`

Ein Systemereignis einreihen und optional einen Heartbeat auslösen (Gateway‑RPC).

Erforderlich:

- `--text <text>`

Optionen:

- `--mode <now|next-heartbeat>`
- `--json`
- `--url`, `--token`, `--timeout`, `--expect-final`

### `system heartbeat last|enable|disable`

Heartbeat‑Steuerungen (Gateway‑RPC).

Optionen:

- `--json`
- `--url`, `--token`, `--timeout`, `--expect-final`

### `system presence`

System‑Presence‑Einträge auflisten (Gateway‑RPC).

Optionen:

- `--json`
- `--url`, `--token`, `--timeout`, `--expect-final`

## Cron

Geplante Jobs verwalten (Gateway‑RPC). Siehe [/automation/cron-jobs](/automation/cron-jobs).

Unterbefehle:

- `cron status [--json]`
- `cron list [--all] [--json]` (standardmäßig Tabellenausgabe; verwenden Sie `--json` für roh)
- `cron add` (Alias: `create`; erfordert `--name` und genau eines von `--at` | `--every` | `--cron`, sowie genau eine Payload von `--system-event` | `--message`)
- `cron edit <id>` (Felder patchen)
- `cron rm <id>` (Aliasse: `remove`, `delete`)
- `cron enable <id>`
- `cron disable <id>`
- `cron runs --id <id> [--limit <n>]`
- `cron run <id> [--force]`

Alle `cron`‑Befehle akzeptieren `--url`, `--token`, `--timeout`, `--expect-final`.

## Node‑Host

`node` führt einen **headless Node‑Host** aus oder verwaltet ihn als Hintergrunddienst. Siehe
[`openclaw node`](/cli/node).

Unterbefehle:

- `node run --host <gateway-host> --port 18789`
- `node status`
- `node install [--host <gateway-host>] [--port <port>] [--tls] [--tls-fingerprint <sha256>] [--node-id <id>] [--display-name <name>] [--runtime <node|bun>] [--force]`
- `node uninstall`
- `node stop`
- `node restart`

## Nodes

`nodes` kommuniziert mit dem Gateway und zielt auf gekoppelte Nodes. Siehe [/nodes](/nodes).

Häufige Optionen:

- `--url`, `--token`, `--timeout`, `--json`

Unterbefehle:

- `nodes status [--connected] [--last-connected <duration>]`
- `nodes describe --node <id|name|ip>`
- `nodes list [--connected] [--last-connected <duration>]`
- `nodes pending`
- `nodes approve <requestId>`
- `nodes reject <requestId>`
- `nodes rename --node <id|name|ip> --name <displayName>`
- `nodes invoke --node <id|name|ip> --command <command> [--params <json>] [--invoke-timeout <ms>] [--idempotency-key <key>]`
- `nodes run --node <id|name|ip> [--cwd <path>] [--env KEY=VAL] [--command-timeout <ms>] [--needs-screen-recording] [--invoke-timeout <ms>] <command...>` (Mac‑Node oder headless Node‑Host)
- `nodes notify --node <id|name|ip> [--title <text>] [--body <text>] [--sound <name>] [--priority <passive|active|timeSensitive>] [--delivery <system|overlay|auto>] [--invoke-timeout <ms>]` (nur macOS)

Kamera:

- `nodes camera list --node <id|name|ip>`
- `nodes camera snap --node <id|name|ip> [--facing front|back|both] [--device-id <id>] [--max-width <px>] [--quality <0-1>] [--delay-ms <ms>] [--invoke-timeout <ms>]`
- `nodes camera clip --node <id|name|ip> [--facing front|back] [--device-id <id>] [--duration <ms|10s|1m>] [--no-audio] [--invoke-timeout <ms>]`

Canvas + Bildschirm:

- `nodes canvas snapshot --node <id|name|ip> [--format png|jpg|jpeg] [--max-width <px>] [--quality <0-1>] [--invoke-timeout <ms>]`
- `nodes canvas present --node <id|name|ip> [--target <urlOrPath>] [--x <px>] [--y <px>] [--width <px>] [--height <px>] [--invoke-timeout <ms>]`
- `nodes canvas hide --node <id|name|ip> [--invoke-timeout <ms>]`
- `nodes canvas navigate <url> --node <id|name|ip> [--invoke-timeout <ms>]`
- `nodes canvas eval [<js>] --node <id|name|ip> [--js <code>] [--invoke-timeout <ms>]`
- `nodes canvas a2ui push --node <id|name|ip> (--jsonl <path> | --text <text>) [--invoke-timeout <ms>]`
- `nodes canvas a2ui reset --node <id|name|ip> [--invoke-timeout <ms>]`
- `nodes screen record --node <id|name|ip> [--screen <index>] [--duration <ms|10s>] [--fps <n>] [--no-audio] [--out <path>] [--invoke-timeout <ms>]`

Standort:

- `nodes location get --node <id|name|ip> [--max-age <ms>] [--accuracy <coarse|balanced|precise>] [--location-timeout <ms>] [--invoke-timeout <ms>]`

## Browser

Browser‑Steuerungs‑CLI (dediziertes Chrome/Brave/Edge/Chromium). Siehe [`openclaw browser`](/cli/browser) und das [Browser‑Werkzeug](/tools/browser).

Häufige Optionen:

- `--url`, `--token`, `--timeout`, `--json`
- `--browser-profile <name>`

Verwalten:

- `browser status`
- `browser start`
- `browser stop`
- `browser reset-profile`
- `browser tabs`
- `browser open <url>`
- `browser focus <targetId>`
- `browser close [targetId]`
- `browser profiles`
- `browser create-profile --name <name> [--color <hex>] [--cdp-url <url>]`
- `browser delete-profile --name <name>`

Prüfen:

- `browser screenshot [targetId] [--full-page] [--ref <ref>] [--element <selector>] [--type png|jpeg]`
- `browser snapshot [--format aria|ai] [--target-id <id>] [--limit <n>] [--interactive] [--compact] [--depth <n>] [--selector <sel>] [--out <path>]`

Aktionen:

- `browser navigate <url> [--target-id <id>]`
- `browser resize <width> <height> [--target-id <id>]`
- `browser click <ref> [--double] [--button <left|right|middle>] [--modifiers <csv>] [--target-id <id>]`
- `browser type <ref> <text> [--submit] [--slowly] [--target-id <id>]`
- `browser press <key> [--target-id <id>]`
- `browser hover <ref> [--target-id <id>]`
- `browser drag <startRef> <endRef> [--target-id <id>]`
- `browser select <ref> <values...> [--target-id <id>]`
- `browser upload <paths...> [--ref <ref>] [--input-ref <ref>] [--element <selector>] [--target-id <id>] [--timeout-ms <ms>]`
- `browser fill [--fields <json>] [--fields-file <path>] [--target-id <id>]`
- `browser dialog --accept|--dismiss [--prompt <text>] [--target-id <id>] [--timeout-ms <ms>]`
- `browser wait [--time <ms>] [--text <value>] [--text-gone <value>] [--target-id <id>]`
- `browser evaluate --fn <code> [--ref <ref>] [--target-id <id>]`
- `browser console [--level <error|warn|info>] [--target-id <id>]`
- `browser pdf [--target-id <id>]`

## Dokumentensuche

### `docs [query...]`

Den Live‑Dokumentenindex durchsuchen.

## TUI

### `tui`

Die Terminal‑UI öffnen, die mit dem Gateway verbunden ist.

Optionen:

- `--url <url>`
- `--token <token>`
- `--password <password>`
- `--session <key>`
- `--deliver`
- `--thinking <level>`
- `--message <text>`
- `--timeout-ms <ms>` (Standard: `agents.defaults.timeoutSeconds`)
- `--history-limit <n>`
