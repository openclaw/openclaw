---
summary: "OpenClaw CLI-referens för `openclaw`-kommandon, underkommandon och alternativ"
read_when:
  - Lägga till eller ändra CLI-kommandon eller alternativ
  - Dokumentera nya kommandoytor
title: "CLI-referens"
---

# CLI-referens

Denna sida beskriver det aktuella CLI-beteendet. Om kommandon ändras, uppdatera detta dokument.

## Kommandosidor

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
- [`plugins`](/cli/plugins) (plugin-kommandon)
- [`channels`](/cli/channels)
- [`security`](/cli/security)
- [`skills`](/cli/skills)
- [`voicecall`](/cli/voicecall) (plugin; om installerad)

## Globala flaggor

- `--dev`: isolera tillstånd under `~/.openclaw-dev` och flytta standardportar.
- `--profile <name>`: isolera tillstånd under `~/.openclaw-<name>`.
- `--no-color`: inaktivera ANSI-färger.
- `--update`: genväg för `openclaw update` (endast källinstallationer).
- `-V`, `--version`, `-v`: skriv ut version och avsluta.

## Utdataformatering

- ANSI-färger och förloppsindikatorer renderas endast i TTY-sessioner.
- OSC-8-hyperlänkar renderas som klickbara länkar i terminaler som stöds; annars faller vi tillbaka till vanliga URL:er.
- `--json` (och `--plain` där det stöds) inaktiverar formatering för ren utdata.
- `--no-color` inaktiverar ANSI-formatering; `NO_COLOR=1` respekteras också.
- Långvariga kommandon visar en förloppsindikator (OSC 9;4 där det stöds).

## Färgpalett

OpenClaw använder en hummerpalett för CLI-utdata.

- `accent` (#FF5A2D): rubriker, etiketter, primära markeringar.
- `accentBright` (#FF7A3D): kommandonamn, betoning.
- `accentDim` (#D14A22): sekundär markerad text.
- `info` (#FF8A5B): informationsvärden.
- `success` (#2FBF71): lyckade tillstånd.
- `warn` (#FFB020): varningar, reservlösningar, uppmärksamhet.
- `error` (#E23D2D): fel, misslyckanden.
- `muted` (#8B7F77): nedtoning, metadata.

Palettens källa till sanning: `src/terminal/palette.ts` (aka ”lobster seam”).

## Kommandoträd

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

Obs: plugins kan lägga till ytterligare toppnivåkommandon (till exempel `openclaw voicecall`).

## Säkerhet

- `openclaw security audit` — granska konfig + lokalt tillstånd för vanliga säkerhetsfallgropar.
- `openclaw security audit --deep` — bästa möjliga live-prob av Gateway.
- `openclaw security audit --fix` — skärp säkra standarder och chmod för tillstånd/konfig.

## Plugins

Hantera tillägg och deras konfig:

- `openclaw plugins list` — upptäck plugins (använd `--json` för maskinutdata).
- `openclaw plugins info <id>` — visa detaljer för ett plugin.
- `openclaw plugins install <path|.tgz|npm-spec>` — installera ett plugin (eller lägg till en plugin-sökväg till `plugins.load.paths`).
- `openclaw plugins aktivera <id>` / `inaktivera <id>` — toggle `plugins.entries.<id>.enabled`.
- `openclaw plugins doctor` — rapportera plugin-inläsningsfel.

De flesta plugin-ändringar kräver en omstart av gatewayen. Se [/plugin](/tools/plugin).

## Minne

Vektorsökning över `MEMORY.md` + `memory/*.md`:

- `openclaw memory status` — visa indexstatistik.
- `openclaw memory index` — omindexera minnesfiler.
- `openclaw memory search "<query>"` — semantisk sökning över minne.

## Chattens snedstreckskommandon

Chattmeddelanden stöder `/...` kommandon (text och inföding). Se [/tools/slash-commands](/tools/slash-commands).

Höjdpunkter:

- `/status` för snabb diagnostik.
- `/config` för bestående konfigändringar.
- `/debug` för konfig-åsidosättningar endast vid körning (minne, inte disk; kräver `commands.debug: true`).

## Konfigurering + introduktion

### `setup`

Initiera konfig + arbetsyta.

Alternativ:

- `--workspace <dir>`: sökväg till agentens arbetsyta (standard `~/.openclaw/workspace`).
- `--wizard`: kör introduktionsguiden.
- `--non-interactive`: kör guiden utan uppmaningar.
- `--mode <local|remote>`: guideläge.
- `--remote-url <url>`: fjärr-Gateway-URL.
- `--remote-token <token>`: token för fjärr-Gateway.

Guiden körs automatiskt när någon guideflagga finns (`--non-interactive`, `--mode`, `--remote-url`, `--remote-token`).

### `onboard`

Interaktiv guide för att konfigurera gateway, arbetsyta och skills.

Alternativ:

- `--workspace <dir>`
- `--reset` (återställ konfig + autentiseringsuppgifter + sessioner + arbetsyta före guiden)
- `--non-interactive`
- `--mode <local|remote>`
- `--flow <quickstart|advanced|manual>` (manual är ett alias för advanced)
- `--auth-choice <setup-token|token|chutes|openai-codex|openai-api-key|openrouter-api-key|ai-gateway-api-key|moonshot-api-key|moonshot-api-key-cn|kimi-code-api-key|synthetic-api-key|venice-api-key|gemini-api-key|zai-api-key|apiKey|minimax-api|minimax-api-lightning|opencode-zen|skip>`
- `--token-provider <id>` (icke-interaktiv; används med `--auth-choice token`)
- `--token <token>` (icke-interaktiv; används med `--auth-choice token`)
- `--token-profile-id <id>` (icke-interaktiv; standard: `<provider>:manual`)
- `--token-expires-in <duration>` (non-interactive; e.g. `365d`, `12h`)
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
- `--no-install-daemon` (alias: `--skip-daemon`)
- `--daemon-runtime <node|bun>`
- `--skip-channels`
- `--skip-skills`
- `--skip-health`
- `--skip-ui`
- `--node-manager <npm|pnpm|bun>` (pnpm rekommenderas; bun rekommenderas inte för Gateway-körning)
- `--json`

### `configure`

Interaktiv konfigurationsguide (modeller, kanaler, skills, gateway).

### `config`

Icke-interaktiva konfigurationshjälpare (får/set/unset). Kör `openclaw config` utan
-underkommandot startar guiden.

Underkommandon:

- `config get <path>`: skriv ut ett konfigvärde (punkt-/hakparentes-sökväg).
- `config set <path> <value>`: sätt ett värde (JSON5 eller rå sträng).
- `config unset <path>`: ta bort ett värde.

### `doctor`

Hälsokontroller + snabba åtgärder (konfig + gateway + äldre tjänster).

Alternativ:

- `--no-workspace-suggestions`: inaktivera minneshintar för arbetsyta.
- `--yes`: acceptera standardvärden utan uppmaningar (headless).
- `--non-interactive`: hoppa över uppmaningar; tillämpa endast säkra migreringar.
- `--deep`: skanna systemtjänster efter extra gateway-installationer.

## Kanalhjälpare

### `channels`

Hantera chattkanalkonton (WhatsApp/Telegram/Discord/Google Chat/Slack/Mattermost (plugin)/Signal/iMessage/MS Teams).

Underkommandon:

- `channels list`: visa konfigurerade kanaler och autentiseringsprofiler.
- `channels status`: kontrollera gateway-nåbarhet och kanalhälsa (`--probe` kör extra kontroller; använd `openclaw health` eller `openclaw status --deep` för gateway-hälsoprober).
- Tips: `channels status` skriver ut varningar med föreslagna åtgärder när den kan upptäcka vanliga felkonfigurationer (och pekar dig sedan till `openclaw doctor`).
- `channels logs`: visa senaste kanalloggar från gateway-loggfilen.
- `channels add`: guidebaserad konfigurering när inga flaggor skickas; flaggor växlar till icke-interaktivt läge.
- `channels remove`: inaktivera som standard; skicka `--delete` för att ta bort konfigposter utan uppmaningar.
- `channels login`: interaktiv kanalinloggning (endast WhatsApp Web).
- `channels logout`: logga ut från en kanalsession (om det stöds).

Vanliga alternativ:

- `--channel <name>`: `whatsapp|telegram|discord|googlechat|slack|mattermost|signal|imessage|msteams`
- `--account <id>`: kanal-konto-id (standard `default`)
- `--name <label>`: visningsnamn för kontot

`channels login`-alternativ:

- `--channel <channel>` (standard `whatsapp`; stöder `whatsapp`/`web`)
- `--account <id>`
- `--verbose`

`channels logout`-alternativ:

- `--channel <channel>` (standard `whatsapp`)
- `--account <id>`

`channels list`-alternativ:

- `--no-usage`: hoppa över ögonblicksbilder av modell-leverantörens användning/kvot (endast OAuth/API-backade).
- `--json`: skriv ut JSON (inkluderar användning om inte `--no-usage` är satt).

`channels logs`-alternativ:

- `--channel <name|all>` (standard `all`)
- `--lines <n>` (standard `200`)
- `--json`

Mer information: [/concepts/oauth](/concepts/oauth)

Exempel:

```bash
openclaw channels add --channel telegram --account alerts --name "Alerts Bot" --token $TELEGRAM_BOT_TOKEN
openclaw channels add --channel discord --account work --name "Work Bot" --token $DISCORD_BOT_TOKEN
openclaw channels remove --channel discord --account work --delete
openclaw channels status --probe
openclaw status --deep
```

### `skills`

Lista och inspektera tillgängliga skills samt beredskapsinformation.

Underkommandon:

- `skills list`: lista skills (standard när inget underkommando anges).
- `skills info <name>`: visa detaljer för en skill.
- `skills check`: sammanfattning av redo vs saknade krav.

Alternativ:

- `--eligible`: visa endast redo skills.
- `--json`: skriv ut JSON (ingen formatering).
- `-v`, `--verbose`: inkludera detaljer om saknade krav.

Tips: använd `npx clawhub` för att söka, installera och synkronisera skills.

### `pairing`

Godkänn DM-parkopplingsförfrågningar över kanaler.

Underkommandon:

- `pairing list <channel> [--json]`
- `pairing approve <channel> <code> [--notify]`

### `webhooks gmail`

Gmail Pub/Sub hook setup + runner. Se [/automation/gmail-pubsub](/automation/gmail-pubsub).

Underkommandon:

- `webhooks gmail setup` (kräver `--account <email>`; stöder `--project`, `--topic`, `--subscription`, `--label`, `--hook-url`, `--hook-token`, `--push-token`, `--bind`, `--port`, `--path`, `--include-body`, `--max-bytes`, `--renew-minutes`, `--tailscale`, `--tailscale-path`, `--tailscale-target`, `--push-endpoint`, `--json`)
- `webhooks gmail run` (körningsåsidosättningar för samma flaggor)

### `dns setup`

Wide-area upptäckt DNS-hjälpare (CoreDNS + Tailscale). Se [/gateway/discovery](/gateway/discovery).

Alternativ:

- `--apply`: installera/uppdatera CoreDNS-konfig (kräver sudo; endast macOS).

## Meddelanden + agent

### `message`

Enhetliga utgående meddelanden + kanalåtgärder.

Se: [/cli/message](/cli/message)

Underkommandon:

- `message send|poll|react|reactions|read|edit|delete|pin|unpin|pins|permissions|search|timeout|kick|ban`
- `message thread <create|list|reply>`
- `message emoji <list|upload>`
- `message sticker <send|upload>`
- `message role <info|add|remove>`
- `message channel <info|list>`
- `message member info`
- `message voice status`
- `message event <list|create>`

Exempel:

- `openclaw message send --target +15555550123 --message "Hi"`
- `openclaw meddelande omröstning --channel discord --target channel:123 --poll-question "Snack?" --poll-option Pizza --poll-option Sushi`

### `agent`

Kör en agenttur via Gateway (eller `--local` inbäddad).

Krävs:

- `--message <text>`

Alternativ:

- `--to <dest>` (för sessionsnyckel och valfri leverans)
- `--session-id <id>`
- `--thinking <off|minimal|low|medium|high|xhigh>` (endast GPT-5.2 + Codex-modeller)
- `--verbose <on|full|off>`
- `--channel <whatsapp|telegram|discord|slack|mattermost|signal|imessage|msteams>`
- `--local`
- `--deliver`
- `--json`
- `--timeout <seconds>`

### `agents`

Hantera isolerade agenter (arbetsytor + autentisering + routning).

#### `agents list`

Lista konfigurerade agenter.

Alternativ:

- `--json`
- `--bindings`

#### `agents add [name]`

Lägg till en ny isolerad agent. Kör den guidade guiden såvida flaggor (eller `--non-interactive`) inte passeras; `--workspace` krävs i icke-interaktivt läge.

Alternativ:

- `--workspace <dir>`
- `--model <id>`
- `--agent-dir <dir>`
- `--bind <channel[:accountId]>` (upprepningsbar)
- `--non-interactive`
- `--json`

Bindande specifikationer använder `channel[:accountId]`. När `accountId` utelämnas för WhatsApp används standardkonto-id

#### `agents delete <id>`

Ta bort en agent och rensa dess arbetsyta + tillstånd.

Alternativ:

- `--force`
- `--json`

### `acp`

Kör ACP-bryggan som kopplar IDE:er till Gateway.

Se [`acp`](/cli/acp) för fullständiga alternativ och exempel.

### `status`

Visa länkad sessionshälsa och senaste mottagare.

Alternativ:

- `--json`
- `--all` (full diagnos; skrivskyddad, inklistrabar)
- `--deep` (prob av kanaler)
- `--usage` (visa användning/kvot för modell-leverantörer)
- `--timeout <ms>`
- `--verbose`
- `--debug` (alias för `--verbose`)

Noteringar:

- Översikten inkluderar status för Gateway + nodvärdtjänst när tillgängligt.

### Användningsspårning

OpenClaw kan visa leverantörers användning/kvot när OAuth/API-uppgifter finns.

Ytor:

- `/status` (lägger till en kort rad om leverantörsanvändning när tillgängligt)
- `openclaw status --usage` (skriver ut fullständig leverantörsuppdelning)
- macOS-menyrad (avsnittet Usage under Context)

Noteringar:

- Data kommer direkt från leverantörernas användningsendpoints (inga uppskattningar).
- Leverantörer: Anthropic, GitHub Copilot, OpenAI Codex OAuth, samt Gemini CLI/Antigravity när dessa leverantörsplugins är aktiverade.
- Om inga matchande uppgifter finns är användning dold.
- Detaljer: se [Usage tracking](/concepts/usage-tracking).

### `health`

Hämta hälsa från den körande Gateway.

Alternativ:

- `--json`
- `--timeout <ms>`
- `--verbose`

### `sessions`

Lista lagrade konversationssessioner.

Alternativ:

- `--json`
- `--verbose`
- `--store <path>`
- `--active <minutes>`

## Återställ / Avinstallera

### `reset`

Återställ lokal konfig/tillstånd (behåller CLI installerad).

Alternativ:

- `--scope <config|config+creds+sessions|full>`
- `--yes`
- `--non-interactive`
- `--dry-run`

Noteringar:

- `--non-interactive` kräver `--scope` och `--yes`.

### `uninstall`

Avinstallera gateway-tjänsten + lokal data (CLI kvarstår).

Alternativ:

- `--service`
- `--state`
- `--workspace`
- `--app`
- `--all`
- `--yes`
- `--non-interactive`
- `--dry-run`

Noteringar:

- `--non-interactive` kräver `--yes` och explicita omfång (eller `--all`).

## Gateway

### `gateway`

Kör WebSocket-Gateway.

Alternativ:

- `--port <port>`
- `--bind <loopback|tailnet|lan|auto|custom>`
- `--token <token>`
- `--auth <token|password>`
- `--password <password>`
- `--tailscale <off|serve|funnel>`
- `--tailscale-reset-on-exit`
- `--allow-unconfigured`
- `--dev`
- `--reset` (återställ dev-konfig + autentisering + sessioner + arbetsyta)
- `--force` (döda befintlig lyssnare på porten)
- `--verbose`
- `--claude-cli-logs`
- `--ws-log <auto|full|compact>`
- `--compact` (alias för `--ws-log compact`)
- `--raw-stream`
- `--raw-stream-path <path>`

### `gateway service`

Hantera Gateway-tjänsten (launchd/systemd/schtasks).

Underkommandon:

- `gateway status` (probar Gateway-RPC som standard)
- `gateway install` (tjänstinstallation)
- `gateway uninstall`
- `gateway start`
- `gateway stop`
- `gateway restart`

Noteringar:

- `gateway status` probar Gateway-RPC som standard med tjänstens upplösta port/konfig (åsidosätt med `--url/--token/--password`).
- `gateway status` stöder `--no-probe`, `--deep` och `--json` för skriptning.
- `gatewaystatus` ytor också äldre eller extra gateway-tjänster när det kan upptäcka dem (`--deep` lägger till systemnivåskanningar). Profil-namngivna OpenClaw-tjänster behandlas som förstklassiga och flaggas inte som "extra".
- `gateway status` skriver ut vilken konfigsökväg CLI använder jämfört med vilken konfig tjänsten sannolikt använder (tjänstens miljö), samt den upplösta mål-URL:en för proben.
- `gateway install|uninstall|start|stop|restart` stöder `--json` för skriptning (standardutdata förblir människovänlig).
- `gateway install` använder Node-runtime som standard; bun är **inte rekommenderat** (WhatsApp/Telegram-buggar).
- `gateway install`-alternativ: `--port`, `--runtime`, `--token`, `--force`, `--json`.

### `logs`

Följ Gateway-fil-loggar via RPC.

Noteringar:

- TTY-sessioner renderar en färglagd, strukturerad vy; icke-TTY faller tillbaka till vanlig text.
- `--json` emitterar radavgränsad JSON (en logghändelse per rad).

Exempel:

```bash
openclaw logs --follow
openclaw logs --limit 200
openclaw logs --plain
openclaw logs --json
openclaw logs --no-color
```

### `gateway <subcommand>`

Gateway CLI-hjälpare (använd `--url`, `--token`, `--password`, `--timeout`, `--expect-final` för RPC-underkommandon).
När du skickar `--url`, CLI inte auto-tillämpa konfiguration eller miljö uppgifter.
Inkludera `--token` eller` --lösenord` explicit. Saknar explicita referenser är ett fel.

Underkommandon:

- `gateway call <method> [--params <json>]`
- `gateway health`
- `gateway status`
- `gateway probe`
- `gateway discover`
- `gateway install|uninstall|start|stop|restart`
- `gateway run`

Vanliga RPC:er:

- `config.apply` (validera + skriv konfig + starta om + väck)
- `config.patch` (sammanfoga en partiell uppdatering + starta om + väck)
- `update.run` (kör uppdatering + starta om + väck)

Tips: när du anropar `config.set`/`config.apply`/`config.patch` direkt, skicka `baseHash` från
`config.get` om en konfig redan finns.

## Modeller

Se [/concepts/models](/concepts/models) för fallback-beteende och skanningsstrategi.

Föredragen Anthropic-autentisering (setup-token):

```bash
claude setup-token
openclaw models auth setup-token --provider anthropic
openclaw models status
```

### `models` (rot)

`openclaw models` är ett alias för `models status`.

Rotalternativ:

- `--status-json` (alias för `models status --json`)
- `--status-plain` (alias för `models status --plain`)

### `models list`

Alternativ:

- `--all`
- `--local`
- `--provider <name>`
- `--json`
- `--plain`

### `models status`

Alternativ:

- `--json`
- `--plain`
- `--check` (exit 1=utgånget/saknas, 2=utgår)
- `--probe` (live-prob av konfigurerade autentiseringsprofiler)
- `--probe-provider <name>`
- `--probe-profile <id>` (upprepa eller kommaseparerad)
- `--probe-timeout <ms>`
- `--probe-concurrency <n>`
- `--probe-max-tokens <n>`

Inkluderar alltid auth översikten och OAuth utgångsstatus för profiler i auth butiken.
`--probe` kör live-förfrågningar (kan konsumera tokens och utlösa hastighetsbegränsningar).

### `models set <model>`

Sätt `agents.defaults.model.primary`.

### `models set-image <model>`

Sätt `agents.defaults.imageModel.primary`.

### `models aliases list|add|remove`

Alternativ:

- `list`: `--json`, `--plain`
- `add <alias> <model>`
- `remove <alias>`

### `models fallbacks list|add|remove|clear`

Alternativ:

- `list`: `--json`, `--plain`
- `add <model>`
- `remove <model>`
- `clear`

### `models image-fallbacks list|add|remove|clear`

Alternativ:

- `list`: `--json`, `--plain`
- `add <model>`
- `remove <model>`
- `clear`

### `models scan`

Alternativ:

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

Alternativ:

- `add`: interaktiv autentiseringshjälpare
- `setup-token`: `--provider <name>` (standard `anthropic`), `--yes`
- `paste-token`: `--provider <name>`, `--profile-id <id>`, `--expires-in <duration>`

### `models auth order get|set|clear`

Alternativ:

- `get`: `--provider <name>`, `--agent <id>`, `--json`
- `set`: `--provider <name>`, `--agent <id>`, `<profileIds...>`
- `clear`: `--provider <name>`, `--agent <id>`

## System

### `system event`

Köa en systemhändelse och trigga valfritt ett hjärtslag (Gateway RPC).

Krävs:

- `--text <text>`

Alternativ:

- `--mode <now|next-heartbeat>`
- `--json`
- `--url`, `--token`, `--timeout`, `--expect-final`

### `system heartbeat last|enable|disable`

Kontroller för hjärtslag (Gateway RPC).

Alternativ:

- `--json`
- `--url`, `--token`, `--timeout`, `--expect-final`

### `system presence`

Lista systemets närvaroposter (Gateway RPC).

Alternativ:

- `--json`
- `--url`, `--token`, `--timeout`, `--expect-final`

## Cron

Hantera schemalagda jobb (Gateway RPC). Se [/automation/cron-jobs](/automation/cron-jobs).

Underkommandon:

- `cron status [--json]`
- `cron list [--all] [--json]` (tabellutdata som standard; använd `--json` för rå)
- `cron add` (alias: `create`; kräver `--name` och exakt en av `--at` | `--every` | `--cron`, och exakt en payload av `--system-event` | `--message`)
- `cron edit <id>` (patcha fält)
- `cron rm <id>` (alias: `remove`, `delete`)
- `cron enable <id>`
- `cron disable <id>`
- `cron runs --id <id> [--limit <n>]`
- `cron run <id> [--force]`

Alla `cron`-kommandon accepterar `--url`, `--token`, `--timeout`, `--expect-final`.

## Nodvärd

`node` kör en **huvudlös nod värd** eller hanterar den som en bakgrundstjänst. Se
[`openclaw node`](/cli/node).

Underkommandon:

- `node run --host <gateway-host> --port 18789`
- `node status`
- `node install [--host <gateway-host>] [--port <port>] [--tls] [--tls-fingerprint <sha256>] [--node-id <id>] [--display-name <name>] [--runtime <node|bun>] [--force]`
- `node uninstall`
- `node stop`
- `node restart`

## Noder

`nodes` talar till Gateway och mål parade noder. Se [/nodes](/nodes).

Vanliga alternativ:

- `--url`, `--token`, `--timeout`, `--json`

Underkommandon:

- `nodes status [--connected] [--last-connected <duration>]`
- `nodes describe --node <id|name|ip>`
- `nodes list [--connected] [--last-connected <duration>]`
- `nodes pending`
- `nodes approve <requestId>`
- `nodes reject <requestId>`
- `nodes rename --node <id|name|ip> --name <displayName>`
- `nodes invoke --node <id|name|ip> --command <command> [--params <json>] [--invoke-timeout <ms>] [--idempotency-key <key>]`
- `nodes run --node <id|name|ip> [--cwd <path>] [--env KEY=VAL] [--command-timeout <ms>] [--needs-screen-recording] [--invoke-timeout <ms>] <command...>` (mac-nod eller headless nodvärd)
- `nodes notify --node <id|name|ip> [--title <text>] [--body <text>] [--sound <name>] [--priority <passive|active|timeSensitive>] [--delivery <system|overlay|auto>] [--invoke-timeout <ms>]` (endast mac)

Kamera:

- `nodes camera list --node <id|name|ip>`
- `nodes camera snap --node <id|name|ip> [--facing front|back|both] [--device-id <id>] [--max-width <px>] [--quality <0-1>] [--delay-ms <ms>] [--invoke-timeout <ms>]`
- `nodes camera clip --node <id|name|ip> [--facing front|back] [--device-id <id>] [--duration <ms|10s|1m>] [--no-audio] [--invoke-timeout <ms>]`

Canvas + skärm:

- `nodes canvas snapshot --node <id|name|ip> [--format png|jpg|jpeg] [--max-width <px>] [--quality <0-1>] [--invoke-timeout <ms>]`
- `nodes canvas present --node <id|name|ip> [--target <urlOrPath>] [--x <px>] [--y <px>] [--width <px>] [--height <px>] [--invoke-timeout <ms>]`
- `nodes canvas hide --node <id|name|ip> [--invoke-timeout <ms>]`
- `nodes canvas navigate <url> --node <id|name|ip> [--invoke-timeout <ms>]`
- `nodes canvas eval [<js>] --node <id|name|ip> [--js <code>] [--invoke-timeout <ms>]`
- `nodes canvas a2ui push --node <id|name|ip> (--jsonl <path> | --text <text>) [--invoke-timeout <ms>]`
- `nodes canvas a2ui reset --node <id|name|ip> [--invoke-timeout <ms>]`
- `nodes screen record --node <id|name|ip> [--screen <index>] [--duration <ms|10s>] [--fps <n>] [--no-audio] [--out <path>] [--invoke-timeout <ms>]`

Plats:

- `nodes location get --node <id|name|ip> [--max-age <ms>] [--accuracy <coarse|balanced|precise>] [--location-timeout <ms>] [--invoke-timeout <ms>]`

## Webbläsare

Webbläsarkontroll CLI (dedikerad Chrome/Brave/Edge/Chromium). Se [`openclaw browser`](/cli/browser) och [Browser tool](/tools/browser).

Vanliga alternativ:

- `--url`, `--token`, `--timeout`, `--json`
- `--browser-profile <name>`

Hantera:

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

Inspektera:

- `browser screenshot [targetId] [--full-page] [--ref <ref>] [--element <selector>] [--type png|jpeg]`
- `browser snapshot [--format aria|ai] [--target-id <id>] [--limit <n>] [--interactive] [--compact] [--depth <n>] [--selector <sel>] [--out <path>]`

Åtgärder:

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

## Dokumentsökning

### `docs [query...]`

Sök i det live-indexerade dokumentationsarkivet.

## TUI

### `tui`

Öppna terminal-UI anslutet till Gateway.

Alternativ:

- `--url <url>`
- `--token <token>`
- `--password <password>`
- `--session <key>`
- `--deliver`
- `--thinking <level>`
- `--message <text>`
- `--timeout-ms <ms>` (standard är `agents.defaults.timeoutSeconds`)
- `--history-limit <n>`
