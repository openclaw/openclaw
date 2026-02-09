---
summary: "OpenClaw CLI-referentie voor `openclaw`-opdrachten, subopdrachten en opties"
read_when:
  - CLI-opdrachten of -opties toevoegen of wijzigen
  - Nieuwe opdrachtoppervlakken documenteren
title: "CLI-referentie"
---

# CLI-referentie

Deze pagina beschrijft het huidige CLI-gedrag. Als opdrachten veranderen, werk dit document bij.

## Opdrachtpagina’s

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
- [`plugins`](/cli/plugins) (plugin-opdrachten)
- [`channels`](/cli/channels)
- [`security`](/cli/security)
- [`skills`](/cli/skills)
- [`voicecall`](/cli/voicecall) (plugin; indien geïnstalleerd)

## Globale flags

- `--dev`: isoleer status onder `~/.openclaw-dev` en verschuif standaardpoorten.
- `--profile <name>`: isoleer status onder `~/.openclaw-<name>`.
- `--no-color`: schakel ANSI-kleuren uit.
- `--update`: verkorting voor `openclaw update` (alleen source-installaties).
- `-V`, `--version`, `-v`: toon versie en sluit af.

## Uitvoerstyling

- ANSI-kleuren en voortgangsindicatoren worden alleen weergegeven in TTY-sessies.
- OSC-8-hyperlinks worden als klikbare links weergegeven in ondersteunde terminals; anders vallen we terug op gewone URL’s.
- `--json` (en `--plain` waar ondersteund) schakelt styling uit voor schone uitvoer.
- `--no-color` schakelt ANSI-styling uit; `NO_COLOR=1` wordt ook gerespecteerd.
- Langlopende opdrachten tonen een voortgangsindicator (OSC 9;4 waar ondersteund).

## Kleurenpalet

OpenClaw gebruikt een lobster-palet voor CLI-uitvoer.

- `accent` (#FF5A2D): koppen, labels, primaire accenten.
- `accentBright` (#FF7A3D): opdrachtnamen, nadruk.
- `accentDim` (#D14A22): secundaire accenttekst.
- `info` (#FF8A5B): informatieve waarden.
- `success` (#2FBF71): successtatussen.
- `warn` (#FFB020): waarschuwingen, fallbacks, aandacht.
- `error` (#E23D2D): fouten, mislukkingen.
- `muted` (#8B7F77): minder nadruk, metadata.

Bron van waarheid voor het palet: `src/terminal/palette.ts` (ook wel “lobster seam”).

## Opdrachtboom

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

Let op: plugins kunnen extra top-level opdrachten toevoegen (bijvoorbeeld `openclaw voicecall`).

## Beveiliging

- `openclaw security audit` — audit config + lokale status op veelvoorkomende beveiligingsvalkuilen.
- `openclaw security audit --deep` — best-effort live Gateway-probe.
- `openclaw security audit --fix` — verscherp veilige standaardinstellingen en chmod status/config.

## Plugins

Beheer extensies en hun config:

- `openclaw plugins list` — ontdek plugins (gebruik `--json` voor machine-uitvoer).
- `openclaw plugins info <id>` — toon details voor een plugin.
- `openclaw plugins install <path|.tgz|npm-spec>` — installeer een plugin (of voeg een pluginpad toe aan `plugins.load.paths`).
- `openclaw plugins enable <id>` / `disable <id>` — schakel `plugins.entries.<id>.enabled` in/uit.
- `openclaw plugins doctor` — rapporteer plugin-laadfouten.

De meeste pluginwijzigingen vereisen een herstart van de Gateway. Zie [/plugin](/tools/plugin).

## Memory

Vectorzoekopdrachten over `MEMORY.md` + `memory/*.md`:

- `openclaw memory status` — toon indexstatistieken.
- `openclaw memory index` — herindexeer memory-bestanden.
- `openclaw memory search "<query>"` — semantisch zoeken over memory.

## Chat slash-opdrachten

Chatberichten ondersteunen `/...`-opdrachten (tekst en native). Zie [/tools/slash-commands](/tools/slash-commands).

Hoogtepunten:

- `/status` voor snelle diagnostiek.
- `/config` voor persistente configwijzigingen.
- `/debug` voor alleen-runtime config-overschrijvingen (memory, niet schijf; vereist `commands.debug: true`).

## Installatie + onboarding

### `setup`

Initialiseer config + werkruimte.

Opties:

- `--workspace <dir>`: agent-werkruimtepad (standaard `~/.openclaw/workspace`).
- `--wizard`: voer de onboardingwizard uit.
- `--non-interactive`: voer de wizard uit zonder prompts.
- `--mode <local|remote>`: wizardmodus.
- `--remote-url <url>`: externe Gateway-URL.
- `--remote-token <token>`: extern Gateway-token.

De wizard start automatisch wanneer een van de wizardflags aanwezig is (`--non-interactive`, `--mode`, `--remote-url`, `--remote-token`).

### `onboard`

Interactieve wizard om gateway, werkruimte en skills in te stellen.

Opties:

- `--workspace <dir>`
- `--reset` (reset config + referenties + sessies + werkruimte vóór de wizard)
- `--non-interactive`
- `--mode <local|remote>`
- `--flow <quickstart|advanced|manual>` (manual is een alias voor advanced)
- `--auth-choice <setup-token|token|chutes|openai-codex|openai-api-key|openrouter-api-key|ai-gateway-api-key|moonshot-api-key|moonshot-api-key-cn|kimi-code-api-key|synthetic-api-key|venice-api-key|gemini-api-key|zai-api-key|apiKey|minimax-api|minimax-api-lightning|opencode-zen|skip>`
- `--token-provider <id>` (niet-interactief; gebruikt met `--auth-choice token`)
- `--token <token>` (niet-interactief; gebruikt met `--auth-choice token`)
- `--token-profile-id <id>` (niet-interactief; standaard: `<provider>:manual`)
- `--token-expires-in <duration>` (niet-interactief; bijv. `365d`, `12h`)
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
- `--node-manager <npm|pnpm|bun>` (pnpm aanbevolen; bun niet aanbevolen voor Gateway-runtime)
- `--json`

### `configure`

Interactieve configuratiewizard (models, kanalen, skills, gateway).

### `config`

Niet-interactieve confighelpers (get/set/unset). Het uitvoeren van `openclaw config` zonder
subopdracht start de wizard.

Subopdrachten:

- `config get <path>`: print een configwaarde (punt-/haakpad).
- `config set <path> <value>`: stel een waarde in (JSON5 of ruwe string).
- `config unset <path>`: verwijder een waarde.

### `doctor`

Healthchecks + snelle fixes (config + gateway + legacy-services).

Opties:

- `--no-workspace-suggestions`: schakel hints voor werkruimte-memory uit.
- `--yes`: accepteer standaardwaarden zonder prompts (headless).
- `--non-interactive`: sla prompts over; pas alleen veilige migraties toe.
- `--deep`: scan systeemservices op extra gateway-installaties.

## Kanaalhelpers

### `channels`

Beheer chatkanaalaccounts (WhatsApp/Telegram/Discord/Google Chat/Slack/Mattermost (plugin)/Signal/iMessage/Microsoft Teams).

Subopdrachten:

- `channels list`: toon geconfigureerde kanalen en auth-profielen.
- `channels status`: controleer gateway-bereikbaarheid en kanaalgezondheid (`--probe` voert extra controles uit; gebruik `openclaw health` of `openclaw status --deep` voor gateway-healthprobes).
- Tip: `channels status` toont waarschuwingen met voorgestelde oplossingen wanneer veelvoorkomende misconfiguraties worden gedetecteerd (en verwijst je daarna naar `openclaw doctor`).
- `channels logs`: toon recente kanaallogs uit het gateway-logbestand.
- `channels add`: wizard-achtige installatie wanneer geen flags worden doorgegeven; flags schakelen over naar niet-interactieve modus.
- `channels remove`: standaard uitgeschakeld; geef `--delete` mee om configitems zonder prompts te verwijderen.
- `channels login`: interactieve kanaallogin (alleen WhatsApp Web).
- `channels logout`: meld je af bij een kanaalsessie (indien ondersteund).

Veelgebruikte opties:

- `--channel <name>`: `whatsapp|telegram|discord|googlechat|slack|mattermost|signal|imessage|msteams`
- `--account <id>`: kanaalaccount-id (standaard `default`)
- `--name <label>`: weergavenaam voor het account

`channels login`-opties:

- `--channel <channel>` (standaard `whatsapp`; ondersteunt `whatsapp`/`web`)
- `--account <id>`
- `--verbose`

`channels logout`-opties:

- `--channel <channel>` (standaard `whatsapp`)
- `--account <id>`

`channels list`-opties:

- `--no-usage`: sla snapshots van gebruik/quota van modelproviders over (alleen OAuth/API-ondersteund).
- `--json`: voer JSON uit (inclusief gebruik tenzij `--no-usage` is ingesteld).

`channels logs`-opties:

- `--channel <name|all>` (standaard `all`)
- `--lines <n>` (standaard `200`)
- `--json`

Meer details: [/concepts/oauth](/concepts/oauth)

Voorbeelden:

```bash
openclaw channels add --channel telegram --account alerts --name "Alerts Bot" --token $TELEGRAM_BOT_TOKEN
openclaw channels add --channel discord --account work --name "Work Bot" --token $DISCORD_BOT_TOKEN
openclaw channels remove --channel discord --account work --delete
openclaw channels status --probe
openclaw status --deep
```

### `skills`

Lijst en inspecteer beschikbare skills plus gereedheidsinformatie.

Subopdrachten:

- `skills list`: lijst skills (standaard wanneer geen subopdracht).
- `skills info <name>`: toon details voor één skill.
- `skills check`: samenvatting van gereed vs. ontbrekende vereisten.

Opties:

- `--eligible`: toon alleen gereede skills.
- `--json`: voer JSON uit (geen styling).
- `-v`, `--verbose`: voeg details over ontbrekende vereisten toe.

Tip: gebruik `npx clawhub` om skills te zoeken, installeren en synchroniseren.

### `pairing`

Keur DM-koppelingsverzoeken over kanalen goed.

Subopdrachten:

- `pairing list <channel> [--json]`
- `pairing approve <channel> <code> [--notify]`

### `webhooks gmail`

Gmail Pub/Sub-hookinstallatie + runner. Zie [/automation/gmail-pubsub](/automation/gmail-pubsub).

Subopdrachten:

- `webhooks gmail setup` (vereist `--account <email>`; ondersteunt `--project`, `--topic`, `--subscription`, `--label`, `--hook-url`, `--hook-token`, `--push-token`, `--bind`, `--port`, `--path`, `--include-body`, `--max-bytes`, `--renew-minutes`, `--tailscale`, `--tailscale-path`, `--tailscale-target`, `--push-endpoint`, `--json`)
- `webhooks gmail run` (runtime-overschrijvingen voor dezelfde flags)

### `dns setup`

Wide-area discovery DNS-helper (CoreDNS + Tailscale). Zie [/gateway/discovery](/gateway/discovery).

Opties:

- `--apply`: installeer/update CoreDNS-config (vereist sudo; alleen macOS).

## Messaging + agent

### `message`

Uniforme uitgaande messaging + kanaalacties.

Zie: [/cli/message](/cli/message)

Subopdrachten:

- `message send|poll|react|reactions|read|edit|delete|pin|unpin|pins|permissions|search|timeout|kick|ban`
- `message thread <create|list|reply>`
- `message emoji <list|upload>`
- `message sticker <send|upload>`
- `message role <info|add|remove>`
- `message channel <info|list>`
- `message member info`
- `message voice status`
- `message event <list|create>`

Voorbeelden:

- `openclaw message send --target +15555550123 --message "Hi"`
- `openclaw message poll --channel discord --target channel:123 --poll-question "Snack?" --poll-option Pizza --poll-option Sushi`

### `agent`

Voer één agentbeurt uit via de Gateway (of `--local` ingebed).

Vereist:

- `--message <text>`

Opties:

- `--to <dest>` (voor sessiesleutel en optionele levering)
- `--session-id <id>`
- `--thinking <off|minimal|low|medium|high|xhigh>` (alleen GPT-5.2 + Codex-modellen)
- `--verbose <on|full|off>`
- `--channel <whatsapp|telegram|discord|slack|mattermost|signal|imessage|msteams>`
- `--local`
- `--deliver`
- `--json`
- `--timeout <seconds>`

### `agents`

Beheer geïsoleerde agents (werkruimtes + auth + routering).

#### `agents list`

Lijst geconfigureerde agents.

Opties:

- `--json`
- `--bindings`

#### `agents add [name]`

Voeg een nieuwe geïsoleerde agent toe. Start de begeleide wizard tenzij flags (of `--non-interactive`) worden doorgegeven; `--workspace` is vereist in niet-interactieve modus.

Opties:

- `--workspace <dir>`
- `--model <id>`
- `--agent-dir <dir>`
- `--bind <channel[:accountId]>` (herhaalbaar)
- `--non-interactive`
- `--json`

Bindingsspecificaties gebruiken `channel[:accountId]`. Wanneer `accountId` wordt weggelaten voor WhatsApp, wordt de standaard account-id gebruikt.

#### `agents delete <id>`

Verwijder een agent en snoei diens werkruimte + status.

Opties:

- `--force`
- `--json`

### `acp`

Voer de ACP-bridge uit die IDE’s met de Gateway verbindt.

Zie [`acp`](/cli/acp) voor alle opties en voorbeelden.

### `status`

Toon gekoppelde sessiegezondheid en recente ontvangers.

Opties:

- `--json`
- `--all` (volledige diagnose; alleen-lezen, plakbaar)
- `--deep` (probeer kanalen)
- `--usage` (toon gebruik/quota van modelproviders)
- `--timeout <ms>`
- `--verbose`
- `--debug` (alias voor `--verbose`)

Notities:

- Het overzicht bevat de status van de Gateway + node-hostservice wanneer beschikbaar.

### Gebruik volgen

OpenClaw kan gebruik/quota van providers tonen wanneer OAuth/API-referenties beschikbaar zijn.

Vereist:

- `/status` (voegt een korte regel met providergebruik toe wanneer beschikbaar)
- `openclaw status --usage` (print een volledige provideruitsplitsing)
- macOS-menubalk (sectie Gebruik onder Context)

Notities:

- Gegevens komen rechtstreeks van provider-usage-endpoints (geen schattingen).
- Providers: Anthropic, GitHub Copilot, OpenAI Codex OAuth, plus Gemini CLI/Antigravity wanneer die providerplugins zijn ingeschakeld.
- Als er geen passende referenties bestaan, wordt gebruik verborgen.
- Details: zie [Usage tracking](/concepts/usage-tracking).

### `health`

Haal health op van de draaiende Gateway.

Opties:

- `--json`
- `--timeout <ms>`
- `--verbose`

### `sessions`

Lijst opgeslagen conversatiesessies.

Opties:

- `--json`
- `--verbose`
- `--store <path>`
- `--active <minutes>`

## Resetten / Verwijderen

### `reset`

Reset lokale config/status (houdt de CLI geïnstalleerd).

Opties:

- `--scope <config|config+creds+sessions|full>`
- `--yes`
- `--non-interactive`
- `--dry-run`

Notities:

- `--non-interactive` vereist `--scope` en `--yes`.

### `uninstall`

Verwijder de gatewayservice + lokale gegevens (CLI blijft).

Opties:

- `--service`
- `--state`
- `--workspace`
- `--app`
- `--all`
- `--yes`
- `--non-interactive`
- `--dry-run`

Notities:

- `--non-interactive` vereist `--yes` en expliciete scopes (of `--all`).

## Gateway

### `gateway`

Start de WebSocket-Gateway.

Opties:

- `--port <port>`
- `--bind <loopback|tailnet|lan|auto|custom>`
- `--token <token>`
- `--auth <token|password>`
- `--password <password>`
- `--tailscale <off|serve|funnel>`
- `--tailscale-reset-on-exit`
- `--allow-unconfigured`
- `--dev`
- `--reset` (reset dev-config + referenties + sessies + werkruimte)
- `--force` (beëindig bestaande listener op poort)
- `--verbose`
- `--claude-cli-logs`
- `--ws-log <auto|full|compact>`
- `--compact` (alias voor `--ws-log compact`)
- `--raw-stream`
- `--raw-stream-path <path>`

### `gateway service`

Beheer de Gateway-service (launchd/systemd/schtasks).

Subopdrachten:

- `gateway status` (probeert standaard de Gateway RPC)
- `gateway install` (service-installatie)
- `gateway uninstall`
- `gateway start`
- `gateway stop`
- `gateway restart`

Notities:

- `gateway status` probeert standaard de Gateway RPC met de door de service opgeloste poort/config (overschrijf met `--url/--token/--password`).
- `gateway status` ondersteunt `--no-probe`, `--deep` en `--json` voor scripting.
- `gateway status` toont ook legacy- of extra gatewayservices wanneer deze kunnen worden gedetecteerd (`--deep` voegt systeemniveau-scans toe). Profielgenaamde OpenClaw-services worden als eersteklas beschouwd en niet als “extra” gemarkeerd.
- `gateway status` print welk configpad de CLI gebruikt versus welke config de service waarschijnlijk gebruikt (service-env), plus de opgeloste probe-doel-URL.
- `gateway install|uninstall|start|stop|restart` ondersteunt `--json` voor scripting (standaarduitvoer blijft mensvriendelijk).
- `gateway install` gebruikt standaard de Node-runtime; bun wordt **niet aanbevolen** (WhatsApp/Telegram-bugs).
- `gateway install`-opties: `--port`, `--runtime`, `--token`, `--force`, `--json`.

### `logs`

Tail Gateway-bestandslogs via RPC.

Notities:

- TTY-sessies renderen een gekleurde, gestructureerde weergave; niet-TTY valt terug op platte tekst.
- `--json` produceert regel-gescheiden JSON (één logevent per regel).

Voorbeelden:

```bash
openclaw logs --follow
openclaw logs --limit 200
openclaw logs --plain
openclaw logs --json
openclaw logs --no-color
```

### `gateway <subcommand>`

Gateway CLI-helpers (gebruik `--url`, `--token`, `--password`, `--timeout`, `--expect-final` voor RPC-subopdrachten).
Wanneer je `--url` doorgeeft, past de CLI niet automatisch config- of omgevingsreferenties toe.
Voeg `--token` of `--password` expliciet toe. Ontbrekende expliciete referenties is een fout.

Subopdrachten:

- `gateway call <method> [--params <json>]`
- `gateway health`
- `gateway status`
- `gateway probe`
- `gateway discover`
- `gateway install|uninstall|start|stop|restart`
- `gateway run`

Veelgebruikte RPC’s:

- `config.apply` (valideer + schrijf config + herstart + wekken)
- `config.patch` (voeg een gedeeltelijke update samen + herstart + wekken)
- `update.run` (voer update uit + herstart + wekken)

Tip: wanneer je `config.set`/`config.apply`/`config.patch` direct aanroept, geef `baseHash` mee uit
`config.get` als er al een config bestaat.

## Models

Zie [/concepts/models](/concepts/models) voor fallback-gedrag en scanstrategie.

Voorkeursauthenticatie voor Anthropic (setup-token):

```bash
claude setup-token
openclaw models auth setup-token --provider anthropic
openclaw models status
```

### `models` (root)

`openclaw models` is een alias voor `models status`.

Root-opties:

- `--status-json` (alias voor `models status --json`)
- `--status-plain` (alias voor `models status --plain`)

### `models list`

Opties:

- `--all`
- `--local`
- `--provider <name>`
- `--json`
- `--plain`

### `models status`

Opties:

- `--json`
- `--plain`
- `--check` (exit 1=verlopen/ontbrekend, 2=verloopt binnenkort)
- `--probe` (live probe van geconfigureerde auth-profielen)
- `--probe-provider <name>`
- `--probe-profile <id>` (herhaal of komma-gescheiden)
- `--probe-timeout <ms>`
- `--probe-concurrency <n>`
- `--probe-max-tokens <n>`

Bevat altijd het auth-overzicht en OAuth-verloopstatus voor profielen in de auth-store.
`--probe` voert live verzoeken uit (kan tokens verbruiken en rate limits triggeren).

### `models set <model>`

Stel `agents.defaults.model.primary` in.

### `models set-image <model>`

Stel `agents.defaults.imageModel.primary` in.

### `models aliases list|add|remove`

Opties:

- `list`: `--json`, `--plain`
- `add <alias> <model>`
- `remove <alias>`

### `models fallbacks list|add|remove|clear`

Opties:

- `list`: `--json`, `--plain`
- `add <model>`
- `remove <model>`
- `clear`

### `models image-fallbacks list|add|remove|clear`

Opties:

- `list`: `--json`, `--plain`
- `add <model>`
- `remove <model>`
- `clear`

### `models scan`

Opties:

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

Opties:

- `add`: interactieve auth-helper
- `setup-token`: `--provider <name>` (standaard `anthropic`), `--yes`
- `paste-token`: `--provider <name>`, `--profile-id <id>`, `--expires-in <duration>`

### `models auth order get|set|clear`

Opties:

- `get`: `--provider <name>`, `--agent <id>`, `--json`
- `set`: `--provider <name>`, `--agent <id>`, `<profileIds...>`
- `clear`: `--provider <name>`, `--agent <id>`

## Systeem

### `system event`

Plaats een systeemevenement in de wachtrij en trigger optioneel een heartbeat (Gateway RPC).

Vereist:

- `--text <text>`

Opties:

- `--mode <now|next-heartbeat>`
- `--json`
- `--url`, `--token`, `--timeout`, `--expect-final`

### `system heartbeat last|enable|disable`

Heartbeat-bediening (Gateway RPC).

Opties:

- `--json`
- `--url`, `--token`, `--timeout`, `--expect-final`

### `system presence`

Lijst systeem-presence-items (Gateway RPC).

Opties:

- `--json`
- `--url`, `--token`, `--timeout`, `--expect-final`

## Cron

Beheer geplande taken (Gateway RPC). Zie [/automation/cron-jobs](/automation/cron-jobs).

Subopdrachten:

- `cron status [--json]`
- `cron list [--all] [--json]` (standaard tabeluitvoer; gebruik `--json` voor ruw)
- `cron add` (alias: `create`; vereist `--name` en precies één van `--at` | `--every` | `--cron`, en precies één payload van `--system-event` | `--message`)
- `cron edit <id>` (patch velden)
- `cron rm <id>` (aliassen: `remove`, `delete`)
- `cron enable <id>`
- `cron disable <id>`
- `cron runs --id <id> [--limit <n>]`
- `cron run <id> [--force]`

Alle `cron`-opdrachten accepteren `--url`, `--token`, `--timeout`, `--expect-final`.

## Node-host

`node` draait een **headless node-host** of beheert deze als achtergrondservice. Zie
[`openclaw node`](/cli/node).

Subopdrachten:

- `node run --host <gateway-host> --port 18789`
- `node status`
- `node install [--host <gateway-host>] [--port <port>] [--tls] [--tls-fingerprint <sha256>] [--node-id <id>] [--display-name <name>] [--runtime <node|bun>] [--force]`
- `node uninstall`
- `node stop`
- `node restart`

## Nodes

`nodes` communiceert met de Gateway en richt zich op gekoppelde nodes. Zie [/nodes](/nodes).

Veelgebruikte opties:

- `--url`, `--token`, `--timeout`, `--json`

Subopdrachten:

- `nodes status [--connected] [--last-connected <duration>]`
- `nodes describe --node <id|name|ip>`
- `nodes list [--connected] [--last-connected <duration>]`
- `nodes pending`
- `nodes approve <requestId>`
- `nodes reject <requestId>`
- `nodes rename --node <id|name|ip> --name <displayName>`
- `nodes invoke --node <id|name|ip> --command <command> [--params <json>] [--invoke-timeout <ms>] [--idempotency-key <key>]`
- `nodes run --node <id|name|ip> [--cwd <path>] [--env KEY=VAL] [--command-timeout <ms>] [--needs-screen-recording] [--invoke-timeout <ms>] <command...>` (mac-node of headless node-host)
- `nodes notify --node <id|name|ip> [--title <text>] [--body <text>] [--sound <name>] [--priority <passive|active|timeSensitive>] [--delivery <system|overlay|auto>] [--invoke-timeout <ms>]` (alleen mac)

Camera:

- `nodes camera list --node <id|name|ip>`
- `nodes camera snap --node <id|name|ip> [--facing front|back|both] [--device-id <id>] [--max-width <px>] [--quality <0-1>] [--delay-ms <ms>] [--invoke-timeout <ms>]`
- `nodes camera clip --node <id|name|ip> [--facing front|back] [--device-id <id>] [--duration <ms|10s|1m>] [--no-audio] [--invoke-timeout <ms>]`

Canvas + scherm:

- `nodes canvas snapshot --node <id|name|ip> [--format png|jpg|jpeg] [--max-width <px>] [--quality <0-1>] [--invoke-timeout <ms>]`
- `nodes canvas present --node <id|name|ip> [--target <urlOrPath>] [--x <px>] [--y <px>] [--width <px>] [--height <px>] [--invoke-timeout <ms>]`
- `nodes canvas hide --node <id|name|ip> [--invoke-timeout <ms>]`
- `nodes canvas navigate <url> --node <id|name|ip> [--invoke-timeout <ms>]`
- `nodes canvas eval [<js>] --node <id|name|ip> [--js <code>] [--invoke-timeout <ms>]`
- `nodes canvas a2ui push --node <id|name|ip> (--jsonl <path> | --text <text>) [--invoke-timeout <ms>]`
- `nodes canvas a2ui reset --node <id|name|ip> [--invoke-timeout <ms>]`
- `nodes screen record --node <id|name|ip> [--screen <index>] [--duration <ms|10s>] [--fps <n>] [--no-audio] [--out <path>] [--invoke-timeout <ms>]`

Locatie:

- `nodes location get --node <id|name|ip> [--max-age <ms>] [--accuracy <coarse|balanced|precise>] [--location-timeout <ms>] [--invoke-timeout <ms>]`

## Browser

Browserbedienings-CLI (toegewijde Chrome/Brave/Edge/Chromium). Zie [`openclaw browser`](/cli/browser) en de [Browser-tool](/tools/browser).

Veelgebruikte opties:

- `--url`, `--token`, `--timeout`, `--json`
- `--browser-profile <name>`

Beheren:

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

Inspecteren:

- `browser screenshot [targetId] [--full-page] [--ref <ref>] [--element <selector>] [--type png|jpeg]`
- `browser snapshot [--format aria|ai] [--target-id <id>] [--limit <n>] [--interactive] [--compact] [--depth <n>] [--selector <sel>] [--out <path>]`

Acties:

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

## Documentatie zoeken

### `docs [query...]`

Doorzoek de live documentatie-index.

## TUI

### `tui`

Open de terminal-UI die is verbonden met de Gateway.

Opties:

- `--url <url>`
- `--token <token>`
- `--password <password>`
- `--session <key>`
- `--deliver`
- `--thinking <level>`
- `--message <text>`
- `--timeout-ms <ms>` (standaard `agents.defaults.timeoutSeconds`)
- `--history-limit <n>`
