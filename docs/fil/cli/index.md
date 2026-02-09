---
summary: "Sanggunian ng OpenClaw CLI para sa mga `openclaw` na command, subcommand, at opsyon"
read_when:
  - Pagdaragdag o pagbabago ng mga CLI command o opsyon
  - Pagdodokumento ng mga bagong command surface
title: "Sanggunian ng CLI"
---

# Sanggunian ng CLI

30. Inilalarawan ng pahinang ito ang kasalukuyang gawi ng CLI. 31. Kung magbago ang mga utos, i-update ang dokumentong ito.

## Mga pahina ng command

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
- [`plugins`](/cli/plugins) (mga command ng plugin)
- [`channels`](/cli/channels)
- [`security`](/cli/security)
- [`skills`](/cli/skills)
- [`voicecall`](/cli/voicecall) (plugin; kung naka-install)

## Mga global flag

- `--dev`: ihiwalay ang state sa ilalim ng `~/.openclaw-dev` at ilipat ang mga default port.
- `--profile <name>`: ihiwalay ang state sa ilalim ng `~/.openclaw-<name>`.
- `--no-color`: i-disable ang mga kulay ng ANSI.
- `--update`: shorthand para sa `openclaw update` (source installs lamang).
- `-V`, `--version`, `-v`: i-print ang bersyon at lumabas.

## Pag-istilo ng output

- Ang mga kulay ng ANSI at progress indicator ay nirere-render lamang sa mga TTY session.
- Ang mga OSC-8 hyperlink ay nirere-render bilang mga clickable na link sa mga suportadong terminal; kung hindi, babalik sa plain URL.
- `--json` (at `--plain` kung suportado) ay nagdi-disable ng styling para sa malinis na output.
- `--no-color` ay nagdi-disable ng ANSI styling; iginagalang din ang `NO_COLOR=1`.
- Ang mga long-running na command ay nagpapakita ng progress indicator (OSC 9;4 kapag suportado).

## Paleta ng kulay

Gumagamit ang OpenClaw ng lobster palette para sa CLI output.

- `accent` (#FF5A2D): mga heading, label, pangunahing highlight.
- `accentBright` (#FF7A3D): mga pangalan ng command, diin.
- `accentDim` (#D14A22): pangalawang highlight na teksto.
- `info` (#FF8A5B): mga impormasyong value.
- `success` (#2FBF71): mga estado ng tagumpay.
- `warn` (#FFB020): mga babala, fallback, pansin.
- `error` (#E23D2D): mga error, pagkabigo.
- `muted` (#8B7F77): pagbawas-diin, metadata.

Pinagmulang katotohanan ng paleta: `src/terminal/palette.ts` (aka “lobster seam”).

## Command tree

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

Tandaan: maaaring magdagdag ang mga plugin ng karagdagang top-level na command (halimbawa `openclaw voicecall`).

## Seguridad

- `openclaw security audit` — i-audit ang config + local state para sa mga karaniwang security foot-gun.
- `openclaw security audit --deep` — best-effort na live Gateway probe.
- `openclaw security audit --fix` — higpitan ang mga ligtas na default at i-chmod ang state/config.

## Mga plugin

Pamahalaan ang mga extension at ang kanilang config:

- `openclaw plugins list` — tuklasin ang mga plugin (gamitin ang `--json` para sa machine output).
- `openclaw plugins info <id>` — ipakita ang mga detalye ng isang plugin.
- `openclaw plugins install <path|.tgz|npm-spec>` — mag-install ng plugin (o magdagdag ng plugin path sa `plugins.load.paths`).
- 32. `openclaw plugins enable <id>` / `disable <id>` — i-toggle ang `plugins.entries.<id>.enabled`.
- `openclaw plugins doctor` — iulat ang mga error sa pag-load ng plugin.

33. Karamihan sa mga pagbabago sa plugin ay nangangailangan ng restart ng gateway. 34. Tingnan ang [/plugin](/tools/plugin).

## Memory

Vector search sa `MEMORY.md` + `memory/*.md`:

- `openclaw memory status` — ipakita ang stats ng index.
- `openclaw memory index` — i-reindex ang mga memory file.
- `openclaw memory search "<query>"` — semantic search sa memory.

## Mga chat slash command

35. Sinusuportahan ng mga chat message ang mga `/...` na utos (text at native). 36. Tingnan ang [/tools/slash-commands](/tools/slash-commands).

Mga highlight:

- `/status` para sa mabilis na diagnostics.
- `/config` para sa mga persisted na pagbabago sa config.
- `/debug` para sa runtime-only na config override (memory, hindi disk; nangangailangan ng `commands.debug: true`).

## Setup + onboarding

### `setup`

I-initialize ang config + workspace.

Mga opsyon:

- `--workspace <dir>`: path ng agent workspace (default `~/.openclaw/workspace`).
- `--wizard`: patakbuhin ang onboarding wizard.
- `--non-interactive`: patakbuhin ang wizard nang walang prompt.
- `--mode <local|remote>`: wizard mode.
- `--remote-url <url>`: remote Gateway URL.
- `--remote-token <token>`: remote Gateway token.

Awtomatikong tatakbo ang wizard kapag may alinman sa mga wizard flag (`--non-interactive`, `--mode`, `--remote-url`, `--remote-token`).

### `onboard`

Interactive wizard para i-setup ang gateway, workspace, at skills.

Mga opsyon:

- `--workspace <dir>`
- `--reset` (i-reset ang config + credentials + sessions + workspace bago ang wizard)
- `--non-interactive`
- `--mode <local|remote>`
- `--flow <quickstart|advanced|manual>` (ang manual ay alias ng advanced)
- `--auth-choice <setup-token|token|chutes|openai-codex|openai-api-key|openrouter-api-key|ai-gateway-api-key|moonshot-api-key|moonshot-api-key-cn|kimi-code-api-key|synthetic-api-key|venice-api-key|gemini-api-key|zai-api-key|apiKey|minimax-api|minimax-api-lightning|opencode-zen|skip>`
- `--token-provider <id>` (non-interactive; ginagamit kasama ng `--auth-choice token`)
- `--token <token>` (non-interactive; ginagamit kasama ng `--auth-choice token`)
- `--token-profile-id <id>` (non-interactive; default: `<provider>:manual`)
- 37. `--token-expires-in <duration>` (non-interactive; hal. `365d`, `12h`)
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
- `--node-manager <npm|pnpm|bun>` (inirerekomenda ang pnpm; hindi inirerekomenda ang bun para sa Gateway runtime)
- `--json`

### `configure`

Interactive na configuration wizard (models, channels, skills, gateway).

### `config`

38. Mga non-interactive na config helper (get/set/unset). 39. Ang pagpapatakbo ng `openclaw config` nang walang subcommand ay maglulunsad ng wizard.

Mga subcommand:

- `config get <path>`: i-print ang isang config value (dot/bracket path).
- `config set <path> <value>`: mag-set ng value (JSON5 o raw string).
- `config unset <path>`: alisin ang isang value.

### `doctor`

Mga health check + mabilis na ayos (config + gateway + legacy services).

Mga opsyon:

- `--no-workspace-suggestions`: i-disable ang mga workspace memory hint.
- `--yes`: tanggapin ang mga default nang walang prompt (headless).
- `--non-interactive`: laktawan ang mga prompt; ilapat lamang ang mga ligtas na migration.
- `--deep`: i-scan ang mga system service para sa karagdagang gateway install.

## Mga channel helper

### `channels`

Pamahalaan ang mga chat channel account (WhatsApp/Telegram/Discord/Google Chat/Slack/Mattermost (plugin)/Signal/iMessage/MS Teams).

Mga subcommand:

- `channels list`: ipakita ang mga naka-configure na channel at auth profile.
- `channels status`: suriin ang abot ng gateway at kalusugan ng channel (`--probe` ay nagpapatakbo ng dagdag na check; gamitin ang `openclaw health` o `openclaw status --deep` para sa mga probe ng kalusugan ng gateway).
- Tip: ang `channels status` ay nagpi-print ng mga babala na may mungkahing ayos kapag natutukoy ang karaniwang maling config (pagkatapos ay itinuturo ka sa `openclaw doctor`).
- `channels logs`: ipakita ang mga kamakailang log ng channel mula sa gateway log file.
- `channels add`: wizard-style na setup kapag walang flag; ang mga flag ay lilipat sa non-interactive mode.
- `channels remove`: naka-disable bilang default; ipasa ang `--delete` para alisin ang mga entry ng config nang walang prompt.
- `channels login`: interactive na channel login (WhatsApp Web lamang).
- `channels logout`: mag-log out sa isang channel session (kung suportado).

Mga karaniwang opsyon:

- `--channel <name>`: `whatsapp|telegram|discord|googlechat|slack|mattermost|signal|imessage|msteams`
- `--account <id>`: channel account id (default `default`)
- `--name <label>`: display name para sa account

Mga opsyon ng `channels login`:

- `--channel <channel>` (default `whatsapp`; sumusuporta sa `whatsapp`/`web`)
- `--account <id>`
- `--verbose`

Mga opsyon ng `channels logout`:

- `--channel <channel>` (default `whatsapp`)
- `--account <id>`

Mga opsyon ng `channels list`:

- `--no-usage`: laktawan ang paggamit/quota snapshot ng model provider (OAuth/API-backed lamang).
- `--json`: JSON output (kasama ang paggamit maliban kung naka-set ang `--no-usage`).

Mga opsyon ng `channels logs`:

- `--channel <name|all>` (default `all`)
- `--lines <n>` (default `200`)
- `--json`

Higit pang detalye: [/concepts/oauth](/concepts/oauth)

Mga halimbawa:

```bash
openclaw channels add --channel telegram --account alerts --name "Alerts Bot" --token $TELEGRAM_BOT_TOKEN
openclaw channels add --channel discord --account work --name "Work Bot" --token $DISCORD_BOT_TOKEN
openclaw channels remove --channel discord --account work --delete
openclaw channels status --probe
openclaw status --deep
```

### `skills`

Ilista at siyasatin ang mga available na skills kasama ang impormasyon ng kahandaan.

Mga subcommand:

- `skills list`: ilista ang skills (default kapag walang subcommand).
- `skills info <name>`: ipakita ang mga detalye ng isang skill.
- `skills check`: buod ng handa kumpara sa kulang na mga kinakailangan.

Mga opsyon:

- `--eligible`: ipakita lamang ang mga handang skill.
- `--json`: JSON output (walang styling).
- `-v`, `--verbose`: isama ang detalye ng kulang na mga kinakailangan.

Tip: gamitin ang `npx clawhub` para maghanap, mag-install, at mag-sync ng skills.

### `pairing`

Aprubahan ang mga DM pairing request sa iba’t ibang channel.

Mga subcommand:

- `pairing list <channel> [--json]`
- `pairing approve <channel> <code> [--notify]`

### `webhooks gmail`

40. Gmail Pub/Sub hook setup + runner. 41. Tingnan ang [/automation/gmail-pubsub](/automation/gmail-pubsub).

Mga subcommand:

- `webhooks gmail setup` (nangangailangan ng `--account <email>`; sumusuporta sa `--project`, `--topic`, `--subscription`, `--label`, `--hook-url`, `--hook-token`, `--push-token`, `--bind`, `--port`, `--path`, `--include-body`, `--max-bytes`, `--renew-minutes`, `--tailscale`, `--tailscale-path`, `--tailscale-target`, `--push-endpoint`, `--json`)
- `webhooks gmail run` (runtime override para sa parehong flag)

### `dns setup`

42. Wide-area discovery DNS helper (CoreDNS + Tailscale). 43. Tingnan ang [/gateway/discovery](/gateway/discovery).

Mga opsyon:

- `--apply`: i-install/i-update ang CoreDNS config (nangangailangan ng sudo; macOS lamang).

## Messaging + agent

### `message`

Pinag-isang outbound messaging + mga aksyon ng channel.

Tingnan: [/cli/message](/cli/message)

Mga subcommand:

- `message send|poll|react|reactions|read|edit|delete|pin|unpin|pins|permissions|search|timeout|kick|ban`
- `message thread <create|list|reply>`
- `message emoji <list|upload>`
- `message sticker <send|upload>`
- `message role <info|add|remove>`
- `message channel <info|list>`
- `message member info`
- `message voice status`
- `message event <list|create>`

Mga halimbawa:

- `openclaw message send --target +15555550123 --message "Hi"`
- 44. `openclaw message poll --channel discord --target channel:123 --poll-question "Snack?" 45. --poll-option Pizza --poll-option Sushi`

### `agent`

Patakbuhin ang isang agent turn sa pamamagitan ng Gateway (o naka-embed na `--local`).

Kinakailangan:

- `--message <text>`

Mga opsyon:

- `--to <dest>` (para sa session key at opsyonal na delivery)
- `--session-id <id>`
- `--thinking <off|minimal|low|medium|high|xhigh>` (GPT-5.2 + Codex models lamang)
- `--verbose <on|full|off>`
- `--channel <whatsapp|telegram|discord|slack|mattermost|signal|imessage|msteams>`
- `--local`
- `--deliver`
- `--json`
- `--timeout <seconds>`

### `agents`

Pamahalaan ang mga isolated agent (workspaces + auth + routing).

#### `agents list`

Ilista ang mga naka-configure na agent.

Mga opsyon:

- `--json`
- `--bindings`

#### `agents add [name]`

46. Magdagdag ng bagong isolated agent. 47. Pinapatakbo ang guided wizard maliban kung may ipinasa na mga flag (o `--non-interactive`); kinakailangan ang `--workspace` sa non-interactive mode.

Mga opsyon:

- `--workspace <dir>`
- `--model <id>`
- `--agent-dir <dir>`
- `--bind <channel[:accountId]>` (maaaring ulitin)
- `--non-interactive`
- `--json`

48. Gumagamit ang mga binding spec ng `channel[:accountId]`. 49. Kapag inalis ang `accountId` para sa WhatsApp, ginagamit ang default na account id.

#### `agents delete <id>`

Burahin ang isang agent at i-prune ang workspace + state nito.

Mga opsyon:

- `--force`
- `--json`

### `acp`

Patakbuhin ang ACP bridge na kumokonekta sa mga IDE sa Gateway.

Tingnan ang [`acp`](/cli/acp) para sa kumpletong mga opsyon at halimbawa.

### `status`

Ipakita ang kalusugan ng naka-link na session at mga kamakailang recipient.

Mga opsyon:

- `--json`
- `--all` (buong diagnosis; read-only, madaling i-paste)
- `--deep` (i-probe ang mga channel)
- `--usage` (ipakita ang paggamit/quota ng model provider)
- `--timeout <ms>`
- `--verbose`
- `--debug` (alias para sa `--verbose`)

Mga tala:

- Kasama sa overview ang status ng Gateway + node host service kapag available.

### Pagsubaybay sa paggamit

Maaaring ilantad ng OpenClaw ang paggamit/quota ng provider kapag available ang OAuth/API creds.

Mga surface:

- `/status` (nagdadagdag ng maikling linya ng paggamit ng provider kapag available)
- `openclaw status --usage` (nagpi-print ng buong breakdown ng provider)
- macOS menu bar (Usage section sa ilalim ng Context)

Mga tala:

- Direktang nagmumula ang data sa mga endpoint ng paggamit ng provider (walang estimate).
- Mga provider: Anthropic, GitHub Copilot, OpenAI Codex OAuth, pati Gemini CLI/Antigravity kapag naka-enable ang mga provider plugin na iyon.
- Kung walang katugmang credential, nakatago ang paggamit.
- Mga detalye: tingnan ang [Usage tracking](/concepts/usage-tracking).

### `health`

Kunin ang health mula sa tumatakbong Gateway.

Mga opsyon:

- `--json`
- `--timeout <ms>`
- `--verbose`

### `sessions`

Ilista ang mga naka-store na conversation session.

Mga opsyon:

- `--json`
- `--verbose`
- `--store <path>`
- `--active <minutes>`

## Reset / Uninstall

### `reset`

I-reset ang local config/state (mananatiling naka-install ang CLI).

Mga opsyon:

- `--scope <config|config+creds+sessions|full>`
- `--yes`
- `--non-interactive`
- `--dry-run`

Mga tala:

- Nangangailangan ang `--non-interactive` ng `--scope` at `--yes`.

### `uninstall`

I-uninstall ang gateway service + local data (mananatili ang CLI).

Mga opsyon:

- `--service`
- `--state`
- `--workspace`
- `--app`
- `--all`
- `--yes`
- `--non-interactive`
- `--dry-run`

Mga tala:

- Nangangailangan ang `--non-interactive` ng `--yes` at mga tahasang scope (o `--all`).

## Gateway

### `gateway`

Patakbuhin ang WebSocket Gateway.

Mga opsyon:

- `--port <port>`
- `--bind <loopback|tailnet|lan|auto|custom>`
- `--token <token>`
- `--auth <token|password>`
- `--password <password>`
- `--tailscale <off|serve|funnel>`
- `--tailscale-reset-on-exit`
- `--allow-unconfigured`
- `--dev`
- `--reset` (i-reset ang dev config + credentials + sessions + workspace)
- `--force` (patayin ang umiiral na listener sa port)
- `--verbose`
- `--claude-cli-logs`
- `--ws-log <auto|full|compact>`
- `--compact` (alias para sa `--ws-log compact`)
- `--raw-stream`
- `--raw-stream-path <path>`

### `gateway service`

Pamahalaan ang Gateway service (launchd/systemd/schtasks).

Mga subcommand:

- `gateway status` (default na nagpo-probe sa Gateway RPC)
- `gateway install` (service install)
- `gateway uninstall`
- `gateway start`
- `gateway stop`
- `gateway restart`

Mga tala:

- Ang `gateway status` ay nagpo-probe sa Gateway RPC bilang default gamit ang resolved port/config ng service (i-override gamit ang `--url/--token/--password`).
- Sinusuportahan ng `gateway status` ang `--no-probe`, `--deep`, at `--json` para sa scripting.
- 50. Ang `gateway status` ay nagpapakita rin ng mga legacy o karagdagang gateway service kapag kaya nitong matukoy ang mga ito (`--deep` ay nagdaragdag ng system-level na pag-scan). Ang mga serbisyong OpenClaw na pinangalanan ayon sa profile ay itinuturing na first-class at hindi tinatag bilang "extra".
- Ang `gateway status` ay nagpi-print kung aling config path ang ginagamit ng CLI kumpara sa malamang na ginagamit ng service (service env), kasama ang resolved probe target URL.
- Ang `gateway install|uninstall|start|stop|restart` ay sumusuporta sa `--json` para sa scripting (mananatiling human-friendly ang default output).
- Ang `gateway install` ay default sa Node runtime; **hindi inirerekomenda** ang bun (mga bug sa WhatsApp/Telegram).
- Mga opsyon ng `gateway install`: `--port`, `--runtime`, `--token`, `--force`, `--json`.

### `logs`

I-tail ang mga Gateway file log sa pamamagitan ng RPC.

Mga tala:

- Ang mga TTY session ay nirere-render ang may kulay at structured na view; ang non-TTY ay babalik sa plain text.
- Ang `--json` ay naglalabas ng line-delimited JSON (isang log event bawat linya).

Mga halimbawa:

```bash
openclaw logs --follow
openclaw logs --limit 200
openclaw logs --plain
openclaw logs --json
openclaw logs --no-color
```

### `gateway <subcommand>`

Mga helper ng Gateway CLI (gamitin ang `--url`, `--token`, `--password`, `--timeout`, `--expect-final` para sa mga RPC subcommand).
Kapag ipinasa mo ang `--url`, hindi awtomatikong ina-apply ng CLI ang mga kredensyal mula sa config o environment.
Isama ang `--token` o `--password` nang tahasan. Ang kakulangan ng tahasang kredensyal ay isang error.

Mga subcommand:

- `gateway call <method> [--params <json>]`
- `gateway health`
- `gateway status`
- `gateway probe`
- `gateway discover`
- `gateway install|uninstall|start|stop|restart`
- `gateway run`

Mga karaniwang RPC:

- `config.apply` (i-validate + isulat ang config + i-restart + gisingin)
- `config.patch` (pagsamahin ang bahagyang update + i-restart + gisingin)
- `update.run` (patakbuhin ang update + i-restart + gisingin)

Tip: kapag tinatawag nang direkta ang `config.set`/`config.apply`/`config.patch`, ipasa ang `baseHash` mula sa
`config.get` kung may umiiral nang config.

## Models

Tingnan ang [/concepts/models](/concepts/models) para sa fallback behavior at scanning strategy.

Preferred na Anthropic auth (setup-token):

```bash
claude setup-token
openclaw models auth setup-token --provider anthropic
openclaw models status
```

### `models` (root)

Ang `openclaw models` ay alias ng `models status`.

Mga opsyon sa root:

- `--status-json` (alias para sa `models status --json`)
- `--status-plain` (alias para sa `models status --plain`)

### `models list`

Mga opsyon:

- `--all`
- `--local`
- `--provider <name>`
- `--json`
- `--plain`

### `models status`

Mga opsyon:

- `--json`
- `--plain`
- `--check` (exit 1=expired/kulang, 2=mag-e-expire)
- `--probe` (live probe ng mga naka-configure na auth profile)
- `--probe-provider <name>`
- `--probe-profile <id>` (ulit o comma-separated)
- `--probe-timeout <ms>`
- `--probe-concurrency <n>`
- `--probe-max-tokens <n>`

Palaging kasama ang auth overview at OAuth expiry status para sa mga profile sa auth store.
Ang `--probe` ay nagpapatakbo ng mga live na request (maaaring kumonsumo ng mga token at mag-trigger ng rate limits).

### `models set <model>`

I-set ang `agents.defaults.model.primary`.

### `models set-image <model>`

I-set ang `agents.defaults.imageModel.primary`.

### `models aliases list|add|remove`

Mga opsyon:

- `list`: `--json`, `--plain`
- `add <alias> <model>`
- `remove <alias>`

### `models fallbacks list|add|remove|clear`

Mga opsyon:

- `list`: `--json`, `--plain`
- `add <model>`
- `remove <model>`
- `clear`

### `models image-fallbacks list|add|remove|clear`

Mga opsyon:

- `list`: `--json`, `--plain`
- `add <model>`
- `remove <model>`
- `clear`

### `models scan`

Mga opsyon:

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

Mga opsyon:

- `add`: interactive na auth helper
- `setup-token`: `--provider <name>` (default `anthropic`), `--yes`
- `paste-token`: `--provider <name>`, `--profile-id <id>`, `--expires-in <duration>`

### `models auth order get|set|clear`

Mga opsyon:

- `get`: `--provider <name>`, `--agent <id>`, `--json`
- `set`: `--provider <name>`, `--agent <id>`, `<profileIds...>`
- `clear`: `--provider <name>`, `--agent <id>`

## System

### `system event`

I-enqueue ang isang system event at opsyonal na mag-trigger ng heartbeat (Gateway RPC).

Kinakailangan:

- `--text <text>`

Mga opsyon:

- `--mode <now|next-heartbeat>`
- `--json`
- `--url`, `--token`, `--timeout`, `--expect-final`

### `system heartbeat last|enable|disable`

Mga kontrol ng heartbeat (Gateway RPC).

Mga opsyon:

- `--json`
- `--url`, `--token`, `--timeout`, `--expect-final`

### `system presence`

Ilista ang mga entry ng system presence (Gateway RPC).

Mga opsyon:

- `--json`
- `--url`, `--token`, `--timeout`, `--expect-final`

## Cron

Pamahalaan ang mga naka-iskedyul na job (Gateway RPC). Tingnan ang [/automation/cron-jobs](/automation/cron-jobs).

Mga subcommand:

- `cron status [--json]`
- `cron list [--all] [--json]` (table output bilang default; gamitin ang `--json` para sa raw)
- `cron add` (alias: `create`; nangangailangan ng `--name` at eksaktong isa sa `--at` | `--every` | `--cron`, at eksaktong isang payload ng `--system-event` | `--message`)
- `cron edit <id>` (i-patch ang mga field)
- `cron rm <id>` (mga alias: `remove`, `delete`)
- `cron enable <id>`
- `cron disable <id>`
- `cron runs --id <id> [--limit <n>]`
- `cron run <id> [--force]`

Tumatanggap ang lahat ng `cron` na command ng `--url`, `--token`, `--timeout`, `--expect-final`.

## Node host

Ang `node` ay nagpapatakbo ng isang **headless node host** o pinamamahalaan ito bilang background service. Tingnan ang
[`openclaw node`](/cli/node).

Mga subcommand:

- `node run --host <gateway-host> --port 18789`
- `node status`
- `node install [--host <gateway-host>] [--port <port>] [--tls] [--tls-fingerprint <sha256>] [--node-id <id>] [--display-name <name>] [--runtime <node|bun>] [--force]`
- `node uninstall`
- `node stop`
- `node restart`

## Nodes

Ang `nodes` ay nakikipag-usap sa Gateway at tinatarget ang mga naka-pair na node. Tingnan ang [/nodes](/nodes).

Mga karaniwang opsyon:

- `--url`, `--token`, `--timeout`, `--json`

Mga subcommand:

- `nodes status [--connected] [--last-connected <duration>]`
- `nodes describe --node <id|name|ip>`
- `nodes list [--connected] [--last-connected <duration>]`
- `nodes pending`
- `nodes approve <requestId>`
- `nodes reject <requestId>`
- `nodes rename --node <id|name|ip> --name <displayName>`
- `nodes invoke --node <id|name|ip> --command <command> [--params <json>] [--invoke-timeout <ms>] [--idempotency-key <key>]`
- `nodes run --node <id|name|ip> [--cwd <path>] [--env KEY=VAL] [--command-timeout <ms>] [--needs-screen-recording] [--invoke-timeout <ms>] <command...>` (mac node o headless node host)
- `nodes notify --node <id|name|ip> [--title <text>] [--body <text>] [--sound <name>] [--priority <passive|active|timeSensitive>] [--delivery <system|overlay|auto>] [--invoke-timeout <ms>]` (mac lamang)

Camera:

- `nodes camera list --node <id|name|ip>`
- `nodes camera snap --node <id|name|ip> [--facing front|back|both] [--device-id <id>] [--max-width <px>] [--quality <0-1>] [--delay-ms <ms>] [--invoke-timeout <ms>]`
- `nodes camera clip --node <id|name|ip> [--facing front|back] [--device-id <id>] [--duration <ms|10s|1m>] [--no-audio] [--invoke-timeout <ms>]`

Canvas + screen:

- `nodes canvas snapshot --node <id|name|ip> [--format png|jpg|jpeg] [--max-width <px>] [--quality <0-1>] [--invoke-timeout <ms>]`
- `nodes canvas present --node <id|name|ip> [--target <urlOrPath>] [--x <px>] [--y <px>] [--width <px>] [--height <px>] [--invoke-timeout <ms>]`
- `nodes canvas hide --node <id|name|ip> [--invoke-timeout <ms>]`
- `nodes canvas navigate <url> --node <id|name|ip> [--invoke-timeout <ms>]`
- `nodes canvas eval [<js>] --node <id|name|ip> [--js <code>] [--invoke-timeout <ms>]`
- `nodes canvas a2ui push --node <id|name|ip> (--jsonl <path> | --text <text>) [--invoke-timeout <ms>]`
- `nodes canvas a2ui reset --node <id|name|ip> [--invoke-timeout <ms>]`
- `nodes screen record --node <id|name|ip> [--screen <index>] [--duration <ms|10s>] [--fps <n>] [--no-audio] [--out <path>] [--invoke-timeout <ms>]`

Lokasyon:

- `nodes location get --node <id|name|ip> [--max-age <ms>] [--accuracy <coarse|balanced|precise>] [--location-timeout <ms>] [--invoke-timeout <ms>]`

## Browser

Browser control CLI (dedikadong Chrome/Brave/Edge/Chromium). Tingnan ang [`openclaw browser`](/cli/browser) at ang [Browser tool](/tools/browser).

Mga karaniwang opsyon:

- `--url`, `--token`, `--timeout`, `--json`
- `--browser-profile <name>`

Pamahalaan:

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

Siyasatin:

- `browser screenshot [targetId] [--full-page] [--ref <ref>] [--element <selector>] [--type png|jpeg]`
- `browser snapshot [--format aria|ai] [--target-id <id>] [--limit <n>] [--interactive] [--compact] [--depth <n>] [--selector <sel>] [--out <path>]`

Mga aksyon:

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

## Paghahanap sa docs

### `docs [query...]`

Maghanap sa live docs index.

## TUI

### `tui`

Buksan ang terminal UI na nakakonekta sa Gateway.

Mga opsyon:

- `--url <url>`
- `--token <token>`
- `--password <password>`
- `--session <key>`
- `--deliver`
- `--thinking <level>`
- `--message <text>`
- `--timeout-ms <ms>` (default sa `agents.defaults.timeoutSeconds`)
- `--history-limit <n>`
