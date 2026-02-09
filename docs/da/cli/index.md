---
summary: "OpenClaw CLI-reference for `openclaw`-kommandoer, underkommandoer og indstillinger"
read_when:
  - Tilføjelse eller ændring af CLI-kommandoer eller -indstillinger
  - Dokumentation af nye kommandoflader
title: "CLI-reference"
---

# CLI-reference

Denne side beskriver den aktuelle CLI opførsel. Hvis kommandoer ændres, skal du opdatere denne dokument.

## Kommandosider

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
- [`plugins`](/cli/plugins) (plugin-kommandoer)
- [`channels`](/cli/channels)
- [`security`](/cli/security)
- [`skills`](/cli/skills)
- [`voicecall`](/cli/voicecall) (plugin; hvis installeret)

## Globale flags

- `--dev`: isolér tilstand under `~/.openclaw-dev` og forskyd standardporte.
- `--profile <name>`: isolér tilstand under `~/.openclaw-<name>`.
- `--no-color`: deaktiver ANSI-farver.
- `--update`: genvej for `openclaw update` (kun kildeinstallationer).
- `-V`, `--version`, `-v`: udskriv version og afslut.

## Output-styling

- ANSI-farver og fremdriftsindikatorer gengives kun i TTY-sessioner.
- OSC-8-hyperlinks gengives som klikbare links i understøttede terminaler; ellers falder vi tilbage til almindelige URL’er.
- `--json` (og `--plain` hvor understøttet) deaktiverer styling for rent output.
- `--no-color` deaktiverer ANSI-styling; `NO_COLOR=1` respekteres også.
- Langvarige kommandoer viser en fremdriftsindikator (OSC 9;4 hvor understøttet).

## Farvepalet

OpenClaw bruger en lobster-palet til CLI-output.

- `accent` (#FF5A2D): overskrifter, labels, primære highlights.
- `accentBright` (#FF7A3D): kommandonavne, fremhævning.
- `accentDim` (#D14A22): sekundær highlight-tekst.
- `info` (#FF8A5B): informative værdier.
- `success` (#2FBF71): succes-tilstande.
- `warn` (#FFB020): advarsler, fallback, opmærksomhed.
- `error` (#E23D2D): fejl, mislykkede handlinger.
- `muted` (#8B7F77): nedtoning, metadata.

Palettens single source of truth: `src/terminal/palette.ts` (aka “lobster seam”).

## Kommandotræ

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

Bemærk: plugins kan tilføje yderligere topniveau-kommandoer (for eksempel `openclaw voicecall`).

## Sikkerhed

- `openclaw security audit` — auditér konfiguration + lokal tilstand for almindelige sikkerhedsfaldgruber.
- `openclaw security audit --deep` — best-effort live Gateway-probe.
- `openclaw security audit --fix` — stram sikre standarder og chmod tilstand/konfiguration.

## Plugins

Administrér udvidelser og deres konfiguration:

- `openclaw plugins list` — find plugins (brug `--json` til maskinoutput).
- `openclaw plugins info <id>` — vis detaljer for et plugin.
- `openclaw plugins install <path|.tgz|npm-spec>` — installér et plugin (eller tilføj en plugin-sti til `plugins.load.paths`).
- `openclaw plugins aktiverer <id>` / `disable <id>` — skift `plugins.entries.<id>.enabled`.
- `openclaw plugins doctor` — rapportér plugin-indlæsningsfejl.

De fleste plugin ændringer kræver en gateway genstart. Se [/plugin](/tools/plugin).

## Hukommelse

Vektorsøgning over `MEMORY.md` + `memory/*.md`:

- `openclaw memory status` — vis indeksstatistik.
- `openclaw memory index` — genindeksér hukommelsesfiler.
- `openclaw memory search "<query>"` — semantisk søgning i hukommelse.

## Chat slash-kommandoer

Chatbeskeder understøtter `/...` kommandoer (tekst og indfødt). Se [/tools/slash-commands](/tools/slash-commands).

Highlights:

- `/status` til hurtig diagnosticering.
- `/config` til vedvarende konfigurationsændringer.
- `/debug` til runtime-only konfigurationsoverstyringer (hukommelse, ikke disk; kræver `commands.debug: true`).

## Opsætning + introduktion

### `setup`

Initialisér konfiguration + workspace.

Indstillinger:

- `--workspace <dir>`: agent-workspace-sti (standard `~/.openclaw/workspace`).
- `--wizard`: kør introduktionsguiden.
- `--non-interactive`: kør guiden uden prompts.
- `--mode <local|remote>`: guidetilstand.
- `--remote-url <url>`: fjern-Gateway-URL.
- `--remote-token <token>`: fjern-Gateway-token.

Guiden kører automatisk, når et hvilket som helst guide-flag er til stede (`--non-interactive`, `--mode`, `--remote-url`, `--remote-token`).

### `onboard`

Interaktiv guide til opsætning af gateway, workspace og skills.

Indstillinger:

- `--workspace <dir>`
- `--reset` (nulstil konfiguration + legitimationsoplysninger + sessioner + workspace før guiden)
- `--non-interactive`
- `--mode <local|remote>`
- `--flow <quickstart|advanced|manual>` (manual er et alias for advanced)
- `--auth-choice <setup-token|token|chutes|openai-codex|openai-api-key|openrouter-api-key|ai-gateway-api-key|moonshot-api-key|moonshot-api-key-cn|kimi-code-api-key|synthetic-api-key|venice-api-key|gemini-api-key|zai-api-key|apiKey|minimax-api|minimax-api-lightning|opencode-zen|skip>`
- `--token-provider <id>` (ikke-interaktiv; bruges med `--auth-choice token`)
- `--token <token>` (ikke-interaktiv; bruges med `--auth-choice token`)
- `--token-profile-id <id>` (ikke-interaktiv; standard: `<provider>:manual`)
- `--token-expires-in <duration>` (ikke-interaktiv; f.eks. `365d`, `12h`)
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
- `--node-manager <npm|pnpm|bun>` (pnpm anbefales; bun anbefales ikke til Gateway-runtime)
- `--json`

### `configure`

Interaktiv konfigurationsguide (modeller, kanaler, skills, gateway).

### `config`

Ikke-interaktive konfig hjælpere (get/set/unset). Kører `openclaw config` uden
underkommando starter guiden.

Underkommandoer:

- `config get <path>`: udskriv en konfigurationsværdi (dot/bracket-sti).
- `config set <path> <value>`: sæt en værdi (JSON5 eller rå streng).
- `config unset <path>`: fjern en værdi.

### `doctor`

Helbredstjek + hurtige rettelser (konfiguration + gateway + legacy-tjenester).

Indstillinger:

- `--no-workspace-suggestions`: deaktiver hints for workspace-hukommelse.
- `--yes`: acceptér standarder uden prompts (headless).
- `--non-interactive`: spring prompts over; anvend kun sikre migreringer.
- `--deep`: scan systemtjenester for ekstra gateway-installationer.

## Kanalhjælpere

### `channels`

Administrér chatkanalkonti (WhatsApp/Telegram/Discord/Google Chat/Slack/Mattermost (plugin)/Signal/iMessage/MS Teams).

Underkommandoer:

- `channels list`: vis konfigurerede kanaler og auth-profiler.
- `channels status`: tjek gateway-tilgængelighed og kanalhelbred (`--probe` kører ekstra checks; brug `openclaw health` eller `openclaw status --deep` til gateway-helbredsprober).
- Tip: `channels status` udskriver advarsler med foreslåede rettelser, når almindelige fejlkonfigurationer kan detekteres (og peger dig derefter på `openclaw doctor`).
- `channels logs`: vis seneste kanallogs fra gateway-logfilen.
- `channels add`: guide-baseret opsætning, når ingen flags er angivet; flags skifter til ikke-interaktiv tilstand.
- `channels remove`: deaktiveret som standard; send `--delete` for at fjerne konfigurationsposter uden prompts.
- `channels login`: interaktiv kanallogin (kun WhatsApp Web).
- `channels logout`: log ud af en kanalsession (hvis understøttet).

Fælles indstillinger:

- `--channel <name>`: `whatsapp|telegram|discord|googlechat|slack|mattermost|signal|imessage|msteams`
- `--account <id>`: kanal-konto-id (standard `default`)
- `--name <label>`: visningsnavn for kontoen

`channels login`-indstillinger:

- `--channel <channel>` (standard `whatsapp`; understøtter `whatsapp`/`web`)
- `--account <id>`
- `--verbose`

`channels logout`-indstillinger:

- `--channel <channel>` (standard `whatsapp`)
- `--account <id>`

`channels list`-indstillinger:

- `--no-usage`: spring brug/kvote-snapshots for modeludbydere over (kun OAuth/API-baseret).
- `--json`: output JSON (inkluderer forbrug, medmindre `--no-usage` er sat).

`channels logs`-indstillinger:

- `--channel <name|all>` (standard `all`)
- `--lines <n>` (standard `200`)
- `--json`

Mere detaljer: [/concepts/oauth](/concepts/oauth)

Eksempler:

```bash
openclaw channels add --channel telegram --account alerts --name "Alerts Bot" --token $TELEGRAM_BOT_TOKEN
openclaw channels add --channel discord --account work --name "Work Bot" --token $DISCORD_BOT_TOKEN
openclaw channels remove --channel discord --account work --delete
openclaw channels status --probe
openclaw status --deep
```

### `skills`

Vis og inspicér tilgængelige skills samt parathedsinformation.

Underkommandoer:

- `skills list`: list skills (standard, når ingen underkommando).
- `skills info <name>`: vis detaljer for én skill.
- `skills check`: oversigt over klar vs. manglende krav.

Indstillinger:

- `--eligible`: vis kun klar skills.
- `--json`: output JSON (ingen styling).
- `-v`, `--verbose`: inkluder detaljer om manglende krav.

Tip: brug `npx clawhub` til at søge, installere og synkronisere skills.

### `pairing`

Godkend DM-parringsanmodninger på tværs af kanaler.

Underkommandoer:

- `pairing list <channel> [--json]`
- `pairing approve <channel> <code> [--notify]`

### `webhooks gmail`

Opsætning af Gmail Pub/Sub hook + runner. Se [/automation/gmail-pubsub](/automation/gmail-pubsub).

Underkommandoer:

- `webhooks gmail setup` (kræver `--account <email>`; understøtter `--project`, `--topic`, `--subscription`, `--label`, `--hook-url`, `--hook-token`, `--push-token`, `--bind`, `--port`, `--path`, `--include-body`, `--max-bytes`, `--renew-minutes`, `--tailscale`, `--tailscale-path`, `--tailscale-target`, `--push-endpoint`, `--json`)
- `webhooks gmail run` (runtime-overstyringer for de samme flags)

### `dns setup`

Wide-area opdagelse DNS hjælper (CoreDNS + Tailscale). Se [/gateway/discovery](/gateway/discovery).

Indstillinger:

- `--apply`: installér/opdatér CoreDNS-konfiguration (kræver sudo; kun macOS).

## Beskeder + agent

### `message`

Samlet udgående beskeder + kanalhandlinger.

Se: [/cli/message](/cli/message)

Underkommandoer:

- `message send|poll|react|reactions|read|edit|delete|pin|unpin|pins|permissions|search|timeout|kick|ban`
- `message thread <create|list|reply>`
- `message emoji <list|upload>`
- `message sticker <send|upload>`
- `message role <info|add|remove>`
- `message channel <info|list>`
- `message member info`
- `message voice status`
- `message event <list|create>`

Eksempler:

- `openclaw message send --target +15555550123 --message "Hi"`
- `openclaw besked meningsmåling --channel discord --target kanal:123 --poll-spørgsmål "Snack?" --poll-option Pizza --poll-option Sushi`

### `agent`

Kør én agenttur via Gatewayen (eller `--local` indlejret).

Påkrævet:

- `--message <text>`

Indstillinger:

- `--to <dest>` (til sessionsnøgle og valgfri levering)
- `--session-id <id>`
- `--thinking <off|minimal|low|medium|high|xhigh>` (kun GPT-5.2 + Codex-modeller)
- `--verbose <on|full|off>`
- `--channel <whatsapp|telegram|discord|slack|mattermost|signal|imessage|msteams>`
- `--local`
- `--deliver`
- `--json`
- `--timeout <seconds>`

### `agents`

Administrér isolerede agenter (workspaces + auth + routing).

#### `agents list`

Vis konfigurerede agenter.

Indstillinger:

- `--json`
- `--bindings`

#### `agents add [name]`

Tilføj en ny isoleret agent. Kører guiden med mindre flag (eller `--non-interactive`) er passeret; `--workspace` er påkrævet i ikke-interaktiv tilstand.

Indstillinger:

- `--workspace <dir>`
- `--model <id>`
- `--agent-dir <dir>`
- `--bind <channel[:accountId]>` (kan gentages)
- `--non-interactive`
- `--json`

Binding specs bruge `kanal[:accountId]`. Når `accountId` er udeladt for WhatsApp, bruges standard konto-id.

#### `agents delete <id>`

Slet en agent og beskær dens workspace + tilstand.

Indstillinger:

- `--force`
- `--json`

### `acp`

Kør ACP-bridgen, der forbinder IDE’er til Gatewayen.

Se [`acp`](/cli/acp) for fulde indstillinger og eksempler.

### `status`

Vis helbred for linkede sessioner og seneste modtagere.

Indstillinger:

- `--json`
- `--all` (fuld diagnose; skrivebeskyttet, kan indsættes)
- `--deep` (probe kanaler)
- `--usage` (vis brug/kvote for modeludbydere)
- `--timeout <ms>`
- `--verbose`
- `--debug` (alias for `--verbose`)

Noter:

- Overblikket inkluderer Gateway- og node host-tjenestestatus, når tilgængelig.

### Forbrugssporing

OpenClaw kan vise udbyderforbrug/kvote, når OAuth/API-legitimationsoplysninger er tilgængelige.

Flader:

- `/status` (tilføjer en kort udbyder-forbrugslinje, når tilgængelig)
- `openclaw status --usage` (udskriver fuld udbyderopdeling)
- macOS-menulinje (sektionen Forbrug under Kontekst)

Noter:

- Data kommer direkte fra udbydernes forbrugsendpoints (ingen estimater).
- Udbydere: Anthropic, GitHub Copilot, OpenAI Codex OAuth samt Gemini CLI/Antigravity, når disse udbyder-plugins er aktiveret.
- Hvis der ikke findes matchende legitimationsoplysninger, skjules forbrug.
- Detaljer: se [Forbrugssporing](/concepts/usage-tracking).

### `health`

Hent helbred fra den kørende Gateway.

Indstillinger:

- `--json`
- `--timeout <ms>`
- `--verbose`

### `sessions`

Vis lagrede samtalesessioner.

Indstillinger:

- `--json`
- `--verbose`
- `--store <path>`
- `--active <minutes>`

## Nulstil / Afinstallér

### `reset`

Nulstil lokal konfiguration/tilstand (beholder CLI’en installeret).

Indstillinger:

- `--scope <config|config+creds+sessions|full>`
- `--yes`
- `--non-interactive`
- `--dry-run`

Noter:

- `--non-interactive` kræver `--scope` og `--yes`.

### `uninstall`

Afinstallér gateway-tjenesten + lokale data (CLI’en forbliver).

Indstillinger:

- `--service`
- `--state`
- `--workspace`
- `--app`
- `--all`
- `--yes`
- `--non-interactive`
- `--dry-run`

Noter:

- `--non-interactive` kræver `--yes` og eksplicitte scopes (eller `--all`).

## Gateway

### `gateway`

Kør WebSocket-Gatewayen.

Indstillinger:

- `--port <port>`
- `--bind <loopback|tailnet|lan|auto|custom>`
- `--token <token>`
- `--auth <token|password>`
- `--password <password>`
- `--tailscale <off|serve|funnel>`
- `--tailscale-reset-on-exit`
- `--allow-unconfigured`
- `--dev`
- `--reset` (nulstil dev-konfiguration + legitimationsoplysninger + sessioner + workspace)
- `--force` (dræb eksisterende lytter på port)
- `--verbose`
- `--claude-cli-logs`
- `--ws-log <auto|full|compact>`
- `--compact` (alias for `--ws-log compact`)
- `--raw-stream`
- `--raw-stream-path <path>`

### `gateway service`

Administrér Gateway-tjenesten (launchd/systemd/schtasks).

Underkommandoer:

- `gateway status` (prober Gateway RPC som standard)
- `gateway install` (tjenesteinstallation)
- `gateway uninstall`
- `gateway start`
- `gateway stop`
- `gateway restart`

Noter:

- `gateway status` prober Gateway RPC som standard ved brug af tjenestens løste port/konfiguration (overstyr med `--url/--token/--password`).
- `gateway status` understøtter `--no-probe`, `--deep` og `--json` til scripting.
- `gateway status` også overflader arv eller ekstra gateway tjenester, når det kan opdage dem (`--deep` tilføjer system-niveau scanninger). Profile-navngivne OpenClaw tjenester behandles som førsteklasses og markeres ikke som "ekstra".
- `gateway status` udskriver, hvilken konfigurationssti CLI’en bruger vs. hvilken konfiguration tjenesten sandsynligvis bruger (tjeneste-env), samt den løste probe-mål-URL.
- `gateway install|uninstall|start|stop|restart` understøtter `--json` til scripting (standardoutput forbliver menneskevenligt).
- `gateway install` bruger som standard Node-runtime; bun **anbefales ikke** (WhatsApp/Telegram-fejl).
- `gateway install`-indstillinger: `--port`, `--runtime`, `--token`, `--force`, `--json`.

### `logs`

Tail Gateway-fil-logs via RPC.

Noter:

- TTY-sessioner gengiver en farvelagt, struktureret visning; ikke-TTY falder tilbage til almindelig tekst.
- `--json` udsender linjeopdelt JSON (én loghændelse pr. linje).

Eksempler:

```bash
openclaw logs --follow
openclaw logs --limit 200
openclaw logs --plain
openclaw logs --json
openclaw logs --no-color
```

### `gateway <subcommand>`

Gateway CLI hjælpere (brug `--url`, `--token`, `--password`, `--timeout`, `--expect-final` for RPC underkommandoer).
Når du passerer `--url`, CLI ikke automatisk anvende config eller miljø legitimationsoplysninger.
Inkludér `--token` eller `--password` eksplicit. Manglende eksplicitte legitimationsoplysninger er en fejl.

Underkommandoer:

- `gateway call <method> [--params <json>]`
- `gateway health`
- `gateway status`
- `gateway probe`
- `gateway discover`
- `gateway install|uninstall|start|stop|restart`
- `gateway run`

Fælles RPC’er:

- `config.apply` (validér + skriv konfiguration + genstart + væk)
- `config.patch` (flet en delvis opdatering + genstart + væk)
- `update.run` (kør opdatering + genstart + væk)

Tip: når du kalder `config.set`/`config.apply`/`config.patch` direkte, så angiv `baseHash` fra
`config.get`, hvis en konfiguration allerede findes.

## Modeller

Se [/concepts/models](/concepts/models) for fallback-adfærd og scanningsstrategi.

Foretrukken Anthropic-auth (setup-token):

```bash
claude setup-token
openclaw models auth setup-token --provider anthropic
openclaw models status
```

### `models` (rod)

`openclaw models` er et alias for `models status`.

Rodindstillinger:

- `--status-json` (alias for `models status --json`)
- `--status-plain` (alias for `models status --plain`)

### `models list`

Indstillinger:

- `--all`
- `--local`
- `--provider <name>`
- `--json`
- `--plain`

### `models status`

Indstillinger:

- `--json`
- `--plain`
- `--check` (exit 1=udløbet/mangler, 2=udløber)
- `--probe` (live probe af konfigurerede auth-profiler)
- `--probe-provider <name>`
- `--probe-profile <id>` (gentag eller kommasepareret)
- `--probe-timeout <ms>`
- `--probe-concurrency <n>`
- `--probe-max-tokens <n>`

Altid inkluderer auth oversigt og OAuth udløbsstatus for profiler i auth Store.
`--probe` kører live anmodninger (kan forbruge tokens og udløse hastighedsgrænser).

### `models set <model>`

Sæt `agents.defaults.model.primary`.

### `models set-image <model>`

Sæt `agents.defaults.imageModel.primary`.

### `models aliases list|add|remove`

Indstillinger:

- `list`: `--json`, `--plain`
- `add <alias> <model>`
- `remove <alias>`

### `models fallbacks list|add|remove|clear`

Indstillinger:

- `list`: `--json`, `--plain`
- `add <model>`
- `remove <model>`
- `clear`

### `models image-fallbacks list|add|remove|clear`

Indstillinger:

- `list`: `--json`, `--plain`
- `add <model>`
- `remove <model>`
- `clear`

### `models scan`

Indstillinger:

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

Indstillinger:

- `add`: interaktiv auth-hjælper
- `setup-token`: `--provider <name>` (standard `anthropic`), `--yes`
- `paste-token`: `--provider <name>`, `--profile-id <id>`, `--expires-in <duration>`

### `models auth order get|set|clear`

Indstillinger:

- `get`: `--provider <name>`, `--agent <id>`, `--json`
- `set`: `--provider <name>`, `--agent <id>`, `<profileIds...>`
- `clear`: `--provider <name>`, `--agent <id>`

## System

### `system event`

Sæt en systemhændelse i kø og trig eventuelt et heartbeat (Gateway RPC).

Påkrævet:

- `--text <text>`

Indstillinger:

- `--mode <now|next-heartbeat>`
- `--json`
- `--url`, `--token`, `--timeout`, `--expect-final`

### `system heartbeat last|enable|disable`

Heartbeat-kontroller (Gateway RPC).

Indstillinger:

- `--json`
- `--url`, `--token`, `--timeout`, `--expect-final`

### `system presence`

Vis systemtilstedeværelsesposter (Gateway RPC).

Indstillinger:

- `--json`
- `--url`, `--token`, `--timeout`, `--expect-final`

## Cron

Administrer planlagte jobs (Gateway RPC). Se [/automation/cron-jobs](/automation/cron-jobs).

Underkommandoer:

- `cron status [--json]`
- `cron list [--all] [--json]` (tabeloutput som standard; brug `--json` for rå)
- `cron add` (alias: `create`; kræver `--name` og præcis én af `--at` | `--every` | `--cron`, og præcis én payload af `--system-event` | `--message`)
- `cron edit <id>` (patch felter)
- `cron rm <id>` (aliaser: `remove`, `delete`)
- `cron enable <id>`
- `cron disable <id>`
- `cron runs --id <id> [--limit <n>]`
- `cron run <id> [--force]`

Alle `cron`-kommandoer accepterer `--url`, `--token`, `--timeout`, `--expect-final`.

## Node host

`node` kører en **hovedløs knudevært** eller håndterer det som en baggrundstjeneste. Se
['openclaw node'](/cli/node).

Underkommandoer:

- `node run --host <gateway-host> --port 18789`
- `node status`
- `node install [--host <gateway-host>] [--port <port>] [--tls] [--tls-fingerprint <sha256>] [--node-id <id>] [--display-name <name>] [--runtime <node|bun>] [--force]`
- `node uninstall`
- `node stop`
- `node restart`

## Nodes

`noder` samtaler med Gateway og mål parrede knuder. Se [/nodes](/nodes).

Fælles indstillinger:

- `--url`, `--token`, `--timeout`, `--json`

Underkommandoer:

- `nodes status [--connected] [--last-connected <duration>]`
- `nodes describe --node <id|name|ip>`
- `nodes list [--connected] [--last-connected <duration>]`
- `nodes pending`
- `nodes approve <requestId>`
- `nodes reject <requestId>`
- `nodes rename --node <id|name|ip> --name <displayName>`
- `nodes invoke --node <id|name|ip> --command <command> [--params <json>] [--invoke-timeout <ms>] [--idempotency-key <key>]`
- `nodes run --node <id|name|ip> [--cwd <path>] [--env KEY=VAL] [--command-timeout <ms>] [--needs-screen-recording] [--invoke-timeout <ms>] <command...>` (mac-node eller headless node host)
- `nodes notify --node <id|name|ip> [--title <text>] [--body <text>] [--sound <name>] [--priority <passive|active|timeSensitive>] [--delivery <system|overlay|auto>] [--invoke-timeout <ms>]` (kun mac)

Kamera:

- `nodes camera list --node <id|name|ip>`
- `nodes camera snap --node <id|name|ip> [--facing front|back|both] [--device-id <id>] [--max-width <px>] [--quality <0-1>] [--delay-ms <ms>] [--invoke-timeout <ms>]`
- `nodes camera clip --node <id|name|ip> [--facing front|back] [--device-id <id>] [--duration <ms|10s|1m>] [--no-audio] [--invoke-timeout <ms>]`

Canvas + skærm:

- `nodes canvas snapshot --node <id|name|ip> [--format png|jpg|jpeg] [--max-width <px>] [--quality <0-1>] [--invoke-timeout <ms>]`
- `nodes canvas present --node <id|name|ip> [--target <urlOrPath>] [--x <px>] [--y <px>] [--width <px>] [--height <px>] [--invoke-timeout <ms>]`
- `nodes canvas hide --node <id|name|ip> [--invoke-timeout <ms>]`
- `nodes canvas navigate <url> --node <id|name|ip> [--invoke-timeout <ms>]`
- `nodes canvas eval [<js>] --node <id|name|ip> [--js <code>] [--invoke-timeout <ms>]`
- `nodes canvas a2ui push --node <id|name|ip> (--jsonl <path> | --text <text>) [--invoke-timeout <ms>]`
- `nodes canvas a2ui reset --node <id|name|ip> [--invoke-timeout <ms>]`
- `nodes screen record --node <id|name|ip> [--screen <index>] [--duration <ms|10s>] [--fps <n>] [--no-audio] [--out <path>] [--invoke-timeout <ms>]`

Placering:

- `nodes location get --node <id|name|ip> [--max-age <ms>] [--accuracy <coarse|balanced|precise>] [--location-timeout <ms>] [--invoke-timeout <ms>]`

## Browser

Browser kontrol CLI (dedikeret Chrome/Brave/Edge/Chromium). Se [`openclaw browser`](/cli/browser) og [Browser værktøj](/tools/browser).

Fælles indstillinger:

- `--url`, `--token`, `--timeout`, `--json`
- `--browser-profile <name>`

Administrér:

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

Inspicér:

- `browser screenshot [targetId] [--full-page] [--ref <ref>] [--element <selector>] [--type png|jpeg]`
- `browser snapshot [--format aria|ai] [--target-id <id>] [--limit <n>] [--interactive] [--compact] [--depth <n>] [--selector <sel>] [--out <path>]`

Handlinger:

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

## Dokumentsøgning

### `docs [query...]`

Søg i det live dokumentindeks.

## TUI

### `tui`

Åbn terminal-UI’et forbundet til Gatewayen.

Indstillinger:

- `--url <url>`
- `--token <token>`
- `--password <password>`
- `--session <key>`
- `--deliver`
- `--thinking <level>`
- `--message <text>`
- `--timeout-ms <ms>` (standard til `agents.defaults.timeoutSeconds`)
- `--history-limit <n>`
