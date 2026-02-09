---
summary: "Referencja CLI OpenClaw dla poleceń, podpoleceń i opcji `openclaw`"
read_when:
  - Dodawanie lub modyfikowanie poleceń lub opcji CLI
  - Dokumentowanie nowych powierzchni poleceń
title: "Referencja CLI"
---

# Referencja CLI

Ta strona opisuje bieżące zachowanie CLI. Jeśli polecenia ulegną zmianie, zaktualizuj ten dokument.

## Strony poleceń

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
- [`plugins`](/cli/plugins) (polecenia wtyczek)
- [`channels`](/cli/channels)
- [`security`](/cli/security)
- [`skills`](/cli/skills)
- [`voicecall`](/cli/voicecall) (wtyczka; jeśli zainstalowana)

## Flagi globalne

- `--dev`: izoluje stan w `~/.openclaw-dev` i przesuwa domyślne porty.
- `--profile <name>`: izoluje stan w `~/.openclaw-<name>`.
- `--no-color`: wyłącza kolory ANSI.
- `--update`: skrót dla `openclaw update` (tylko instalacje ze źródeł).
- `-V`, `--version`, `-v`: wypisuje wersję i kończy działanie.

## Stylizacja wyjścia

- Kolory ANSI i wskaźniki postępu renderują się tylko w sesjach TTY.
- Hiperłącza OSC-8 renderują się jako klikalne linki w obsługiwanych terminalach; w przeciwnym razie następuje powrót do zwykłych URL-i.
- `--json` (oraz `--plain`, gdzie obsługiwane) wyłącza stylizację dla czystego wyjścia.
- `--no-color` wyłącza stylizację ANSI; `NO_COLOR=1` jest również respektowane.
- Polecenia długotrwałe pokazują wskaźnik postępu (OSC 9;4, gdy obsługiwane).

## Paleta kolorów

OpenClaw używa palety „lobster” dla wyjścia CLI.

- `accent` (#FF5A2D): nagłówki, etykiety, główne wyróżnienia.
- `accentBright` (#FF7A3D): nazwy poleceń, akcenty.
- `accentDim` (#D14A22): tekst drugorzędnych wyróżnień.
- `info` (#FF8A5B): wartości informacyjne.
- `success` (#2FBF71): stany powodzenia.
- `warn` (#FFB020): ostrzeżenia, mechanizmy zapasowe, uwaga.
- `error` (#E23D2D): błędy, niepowodzenia.
- `muted` (#8B7F77): deakcent, metadane.

Źródło prawdy palety: `src/terminal/palette.ts` (alias „lobster seam”).

## Drzewo poleceń

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

Uwaga: wtyczki mogą dodawać dodatkowe polecenia najwyższego poziomu (na przykład `openclaw voicecall`).

## Bezpieczeństwo

- `openclaw security audit` — audyt konfiguracji i stanu lokalnego pod kątem typowych pułapek bezpieczeństwa.
- `openclaw security audit --deep` — sondowanie Gateway na żywo w trybie best-effort.
- `openclaw security audit --fix` — zaostrzenie bezpiecznych ustawień domyślnych oraz chmod stanu/konfiguracji.

## Wtyczki

Zarządzanie rozszerzeniami i ich konfiguracją:

- `openclaw plugins list` — wykrywanie wtyczek (użyj `--json` dla wyjścia maszynowego).
- `openclaw plugins info <id>` — pokazanie szczegółów wtyczki.
- `openclaw plugins install <path|.tgz|npm-spec>` — instalacja wtyczki (lub dodanie ścieżki wtyczki do `plugins.load.paths`).
- `openclaw plugins enable <id>` / `disable <id>` — przełączanie `plugins.entries.<id>.enabled`.
- `openclaw plugins doctor` — raportowanie błędów ładowania wtyczek.

Większość zmian wtyczek wymaga restartu gateway. Zobacz [/plugin](/tools/plugin).

## Pamięć

Wyszukiwanie wektorowe nad `MEMORY.md` + `memory/*.md`:

- `openclaw memory status` — wyświetlenie statystyk indeksu.
- `openclaw memory index` — ponowne indeksowanie plików pamięci.
- `openclaw memory search "<query>"` — wyszukiwanie semantyczne w pamięci.

## Polecenia slash czatu

Wiadomości czatu obsługują polecenia `/...` (tekstowe i natywne). Zobacz [/tools/slash-commands](/tools/slash-commands).

Wyróżnienia:

- `/status` do szybkiej diagnostyki.
- `/config` do utrwalonych zmian konfiguracji.
- `/debug` do nadpisań konfiguracji tylko w czasie działania (pamięć, nie dysk; wymaga `commands.debug: true`).

## Konfiguracja + onboarding

### `setup`

Inicjalizacja konfiguracji + obszaru roboczego.

Opcje:

- `--workspace <dir>`: ścieżka obszaru roboczego agenta (domyślnie `~/.openclaw/workspace`).
- `--wizard`: uruchomienie kreatora onboardingu.
- `--non-interactive`: uruchomienie kreatora bez monitów.
- `--mode <local|remote>`: tryb kreatora.
- `--remote-url <url>`: zdalny URL Gateway.
- `--remote-token <token>`: token zdalnego Gateway.

Kreator uruchamia się automatycznie, gdy obecna jest którakolwiek flaga kreatora (`--non-interactive`, `--mode`, `--remote-url`, `--remote-token`).

### `onboard`

Interaktywny kreator konfiguracji gateway, obszaru roboczego i skills.

Opcje:

- `--workspace <dir>`
- `--reset` (reset konfiguracji + poświadczeń + sesji + obszaru roboczego przed kreatorem)
- `--non-interactive`
- `--mode <local|remote>`
- `--flow <quickstart|advanced|manual>` (manual jest aliasem dla advanced)
- `--auth-choice <setup-token|token|chutes|openai-codex|openai-api-key|openrouter-api-key|ai-gateway-api-key|moonshot-api-key|moonshot-api-key-cn|kimi-code-api-key|synthetic-api-key|venice-api-key|gemini-api-key|zai-api-key|apiKey|minimax-api|minimax-api-lightning|opencode-zen|skip>`
- `--token-provider <id>` (nieinteraktywny; używany z `--auth-choice token`)
- `--token <token>` (nieinteraktywny; używany z `--auth-choice token`)
- `--token-profile-id <id>` (nieinteraktywny; domyślnie: `<provider>:manual`)
- `--token-expires-in <duration>` (nieinteraktywny; np. `365d`, `12h`)
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
- `--node-manager <npm|pnpm|bun>` (pnpm zalecany; bun niezalecany dla środowiska uruchomieniowego Gateway)
- `--json`

### `configure`

Interaktywny kreator konfiguracji (modele, kanały, skills, gateway).

### `config`

Nieinteraktywne pomocniki konfiguracji (get/set/unset). Uruchomienie `openclaw config` bez
podpolecenia uruchamia kreatora.

Podpolecenia:

- `config get <path>`: wypisanie wartości konfiguracji (ścieżka kropkowa/nawiasowa).
- `config set <path> <value>`: ustawienie wartości (JSON5 lub surowy ciąg).
- `config unset <path>`: usunięcie wartości.

### `doctor`

Kontrole stanu + szybkie naprawy (konfiguracja + gateway + usługi legacy).

Opcje:

- `--no-workspace-suggestions`: wyłączenie podpowiedzi pamięci obszaru roboczego.
- `--yes`: akceptacja domyślnych ustawień bez monitów (headless).
- `--non-interactive`: pominięcie monitów; zastosowanie wyłącznie bezpiecznych migracji.
- `--deep`: skanowanie usług systemowych pod kątem dodatkowych instalacji gateway.

## Pomocniki kanałów

### `channels`

Zarządzanie kontami kanałów czatu (WhatsApp/Telegram/Discord/Google Chat/Slack/Mattermost (wtyczka)/Signal/iMessage/MS Teams).

Podpolecenia:

- `channels list`: wyświetlenie skonfigurowanych kanałów i profili uwierzytelniania.
- `channels status`: sprawdzenie osiągalności gateway i stanu kanałów (`--probe` uruchamia dodatkowe kontrole; użyj `openclaw health` lub `openclaw status --deep` do sond stanu gateway).
- Wskazówka: `channels status` wypisuje ostrzeżenia z sugerowanymi naprawami, gdy potrafi wykryć typowe nieprawidłowe konfiguracje (a następnie wskazuje `openclaw doctor`).
- `channels logs`: pokazanie ostatnich logów kanałów z pliku logów gateway.
- `channels add`: konfiguracja w stylu kreatora, gdy nie przekazano flag; flagi przełączają tryb na nieinteraktywny.
- `channels remove`: domyślnie wyłączone; przekaż `--delete`, aby usunąć wpisy konfiguracji bez monitów.
- `channels login`: interaktywne logowanie do kanału (tylko WhatsApp Web).
- `channels logout`: wylogowanie z sesji kanału (jeśli obsługiwane).

Typowe opcje:

- `--channel <name>`: `whatsapp|telegram|discord|googlechat|slack|mattermost|signal|imessage|msteams`
- `--account <id>`: identyfikator konta kanału (domyślnie `default`)
- `--name <label>`: nazwa wyświetlana konta

Opcje `channels login`:

- `--channel <channel>` (domyślnie `whatsapp`; obsługuje `whatsapp`/`web`)
- `--account <id>`
- `--verbose`

Opcje `channels logout`:

- `--channel <channel>` (domyślnie `whatsapp`)
- `--account <id>`

Opcje `channels list`:

- `--no-usage`: pominięcie migawek użycia/limitów dostawcy modelu (tylko OAuth/API).
- `--json`: wyjście JSON (zawiera użycie, chyba że ustawiono `--no-usage`).

Opcje `channels logs`:

- `--channel <name|all>` (domyślnie `all`)
- `--lines <n>` (domyślnie `200`)
- `--json`

Więcej szczegółów: [/concepts/oauth](/concepts/oauth)

Przykłady:

```bash
openclaw channels add --channel telegram --account alerts --name "Alerts Bot" --token $TELEGRAM_BOT_TOKEN
openclaw channels add --channel discord --account work --name "Work Bot" --token $DISCORD_BOT_TOKEN
openclaw channels remove --channel discord --account work --delete
openclaw channels status --probe
openclaw status --deep
```

### `skills`

Lista i inspekcja dostępnych skills wraz z informacjami o gotowości.

Podpolecenia:

- `skills list`: lista skills (domyślne, gdy brak podpolecenia).
- `skills info <name>`: szczegóły jednej skill.
- `skills check`: podsumowanie gotowych vs brakujących wymagań.

Opcje:

- `--eligible`: pokaż tylko gotowe skills.
- `--json`: wyjście JSON (bez stylizacji).
- `-v`, `--verbose`: dołącz szczegóły brakujących wymagań.

Wskazówka: użyj `npx clawhub`, aby wyszukiwać, instalować i synchronizować skills.

### `pairing`

Zatwierdzanie żądań parowania DM-ów w kanałach.

Podpolecenia:

- `pairing list <channel> [--json]`
- `pairing approve <channel> <code> [--notify]`

### `webhooks gmail`

Konfiguracja i uruchamianie haka Gmail Pub/Sub. Zobacz [/automation/gmail-pubsub](/automation/gmail-pubsub).

Podpolecenia:

- `webhooks gmail setup` (wymaga `--account <email>`; obsługuje `--project`, `--topic`, `--subscription`, `--label`, `--hook-url`, `--hook-token`, `--push-token`, `--bind`, `--port`, `--path`, `--include-body`, `--max-bytes`, `--renew-minutes`, `--tailscale`, `--tailscale-path`, `--tailscale-target`, `--push-endpoint`, `--json`)
- `webhooks gmail run` (nadpisania runtime dla tych samych flag)

### `dns setup`

Pomocnik DNS do wykrywania w szerokim obszarze (CoreDNS + Tailscale). Zobacz [/gateway/discovery](/gateway/discovery).

Opcje:

- `--apply`: instalacja/aktualizacja konfiguracji CoreDNS (wymaga sudo; tylko macOS).

## Wiadomości + agent

### `message`

Ujednolicone wysyłanie wiadomości wychodzących + akcje kanałów.

Zobacz: [/cli/message](/cli/message)

Podpolecenia:

- `message send|poll|react|reactions|read|edit|delete|pin|unpin|pins|permissions|search|timeout|kick|ban`
- `message thread <create|list|reply>`
- `message emoji <list|upload>`
- `message sticker <send|upload>`
- `message role <info|add|remove>`
- `message channel <info|list>`
- `message member info`
- `message voice status`
- `message event <list|create>`

Przykłady:

- `openclaw message send --target +15555550123 --message "Hi"`
- `openclaw message poll --channel discord --target channel:123 --poll-question "Snack?" --poll-option Pizza --poll-option Sushi`

### `agent`

Uruchomienie jednego kroku agenta przez Gateway (lub `--local` w trybie wbudowanym).

Wymagane:

- `--message <text>`

Opcje:

- `--to <dest>` (dla klucza sesji i opcjonalnego dostarczenia)
- `--session-id <id>`
- `--thinking <off|minimal|low|medium|high|xhigh>` (tylko modele GPT-5.2 + Codex)
- `--verbose <on|full|off>`
- `--channel <whatsapp|telegram|discord|slack|mattermost|signal|imessage|msteams>`
- `--local`
- `--deliver`
- `--json`
- `--timeout <seconds>`

### `agents`

Zarządzanie izolowanymi agentami (obszary robocze + uwierzytelnianie + routing).

#### `agents list`

Lista skonfigurowanych agentów.

Opcje:

- `--json`
- `--bindings`

#### `agents add [name]`

Dodanie nowego izolowanego agenta. Uruchamia kreatora prowadzonego, chyba że przekazano flagi (lub `--non-interactive`); `--workspace` jest wymagane w trybie nieinteraktywnym.

Opcje:

- `--workspace <dir>`
- `--model <id>`
- `--agent-dir <dir>`
- `--bind <channel[:accountId]>` (wielokrotne)
- `--non-interactive`
- `--json`

Specyfikacje powiązań używają `channel[:accountId]`. Gdy `accountId` zostanie pominięte dla WhatsApp, używany jest domyślny identyfikator konta.

#### `agents delete <id>`

Usunięcie agenta i przycięcie jego obszaru roboczego + stanu.

Opcje:

- `--force`
- `--json`

### `acp`

Uruchomienie mostu ACP łączącego IDE z Gateway.

Zobacz [`acp`](/cli/acp), aby poznać pełne opcje i przykłady.

### `status`

Wyświetlenie stanu powiązanych sesji i ostatnich odbiorców.

Opcje:

- `--json`
- `--all` (pełna diagnostyka; tylko do odczytu, do wklejenia)
- `--deep` (sondowanie kanałów)
- `--usage` (pokazanie użycia/limitów dostawcy modelu)
- `--timeout <ms>`
- `--verbose`
- `--debug` (alias dla `--verbose`)

Uwagi:

- Przegląd obejmuje status usługi Gateway + hosta węzła, gdy dostępne.

### Śledzenie użycia

OpenClaw może prezentować użycie/limity dostawców, gdy dostępne są poświadczenia OAuth/API.

Powierzchnie:

- `/status` (dodaje krótką linię użycia dostawcy, gdy dostępne)
- `openclaw status --usage` (drukuje pełny podział według dostawców)
- pasek menu macOS (sekcja Użycie w Kontekście)

Uwagi:

- Dane pochodzą bezpośrednio z punktów końcowych użycia dostawców (bez estymacji).
- Dostawcy: Anthropic, GitHub Copilot, OpenAI Codex OAuth oraz Gemini CLI/Antigravity, gdy włączone są odpowiednie wtyczki dostawców.
- Jeśli nie istnieją pasujące poświadczenia, użycie jest ukryte.
- Szczegóły: zobacz [Usage tracking](/concepts/usage-tracking).

### `health`

Pobranie stanu zdrowia z działającego Gateway.

Opcje:

- `--json`
- `--timeout <ms>`
- `--verbose`

### `sessions`

Lista zapisanych sesji rozmów.

Opcje:

- `--json`
- `--verbose`
- `--store <path>`
- `--active <minutes>`

## Reset / Odinstalowanie

### `reset`

Reset lokalnej konfiguracji/stanu (CLI pozostaje zainstalowane).

Opcje:

- `--scope <config|config+creds+sessions|full>`
- `--yes`
- `--non-interactive`
- `--dry-run`

Uwagi:

- `--non-interactive` wymaga `--scope` oraz `--yes`.

### `uninstall`

Odinstalowanie usługi gateway + danych lokalnych (CLI pozostaje).

Opcje:

- `--service`
- `--state`
- `--workspace`
- `--app`
- `--all`
- `--yes`
- `--non-interactive`
- `--dry-run`

Uwagi:

- `--non-interactive` wymaga `--yes` oraz jawnych zakresów (lub `--all`).

## Gateway

### `gateway`

Uruchomienie Gateway WebSocket.

Opcje:

- `--port <port>`
- `--bind <loopback|tailnet|lan|auto|custom>`
- `--token <token>`
- `--auth <token|password>`
- `--password <password>`
- `--tailscale <off|serve|funnel>`
- `--tailscale-reset-on-exit`
- `--allow-unconfigured`
- `--dev`
- `--reset` (reset konfiguracji deweloperskiej + poświadczeń + sesji + obszaru roboczego)
- `--force` (zabicie istniejącego nasłuchu na porcie)
- `--verbose`
- `--claude-cli-logs`
- `--ws-log <auto|full|compact>`
- `--compact` (alias dla `--ws-log compact`)
- `--raw-stream`
- `--raw-stream-path <path>`

### `gateway service`

Zarządzanie usługą Gateway (launchd/systemd/schtasks).

Podpolecenia:

- `gateway status` (domyślnie sonduje RPC Gateway)
- `gateway install` (instalacja usługi)
- `gateway uninstall`
- `gateway start`
- `gateway stop`
- `gateway restart`

Uwagi:

- `gateway status` domyślnie sonduje RPC Gateway, używając rozwiązanego portu/konfiguracji usługi (nadpisz za pomocą `--url/--token/--password`).
- `gateway status` obsługuje `--no-probe`, `--deep` i `--json` do skryptowania.
- `gateway status` ujawnia także legacy lub dodatkowe usługi gateway, gdy potrafi je wykryć (`--deep` dodaje skany na poziomie systemu). Usługi OpenClaw nazwane profilem są traktowane jako pełnoprawne i nie są oznaczane jako „dodatkowe”.
- `gateway status` wypisuje, której ścieżki konfiguracji używa CLI w porównaniu z konfiguracją, której prawdopodobnie używa usługa (środowisko usługi), oraz rozwiązanego docelowego URL sondy.
- `gateway install|uninstall|start|stop|restart` obsługują `--json` do skryptowania (domyślne wyjście pozostaje przyjazne dla ludzi).
- `gateway install` domyślnie używa środowiska Node; bun jest **niezalecany** (błędy WhatsApp/Telegram).
- Opcje `gateway install`: `--port`, `--runtime`, `--token`, `--force`, `--json`.

### `logs`

Podgląd (tail) plikowych logów Gateway przez RPC.

Uwagi:

- Sesje TTY renderują kolorowy, ustrukturyzowany widok; tryb non-TTY wraca do zwykłego tekstu.
- `--json` emituje JSON rozdzielany wierszami (jedno zdarzenie logu na wiersz).

Przykłady:

```bash
openclaw logs --follow
openclaw logs --limit 200
openclaw logs --plain
openclaw logs --json
openclaw logs --no-color
```

### `gateway <subcommand>`

Pomocniki CLI Gateway (użyj `--url`, `--token`, `--password`, `--timeout`, `--expect-final` dla podpoleceń RPC).
Po przekazaniu `--url` CLI nie stosuje automatycznie konfiguracji ani poświadczeń środowiskowych.
Dołącz jawnie `--token` lub `--password`. Brak jawnych poświadczeń jest błędem.

Podpolecenia:

- `gateway call <method> [--params <json>]`
- `gateway health`
- `gateway status`
- `gateway probe`
- `gateway discover`
- `gateway install|uninstall|start|stop|restart`
- `gateway run`

Typowe RPC:

- `config.apply` (walidacja + zapis konfiguracji + restart + wybudzenie)
- `config.patch` (scalenie częściowej aktualizacji + restart + wybudzenie)
- `update.run` (uruchomienie aktualizacji + restart + wybudzenie)

Wskazówka: przy bezpośrednim wywołaniu `config.set`/`config.apply`/`config.patch` przekaż `baseHash` z
`config.get`, jeśli konfiguracja już istnieje.

## Modele

Zobacz [/concepts/models](/concepts/models) w celu poznania zachowania zapasowego i strategii skanowania.

Preferowane uwierzytelnianie Anthropic (setup-token):

```bash
claude setup-token
openclaw models auth setup-token --provider anthropic
openclaw models status
```

### `models` (root)

`openclaw models` jest aliasem dla `models status`.

Opcje root:

- `--status-json` (alias dla `models status --json`)
- `--status-plain` (alias dla `models status --plain`)

### `models list`

Opcje:

- `--all`
- `--local`
- `--provider <name>`
- `--json`
- `--plain`

### `models status`

Opcje:

- `--json`
- `--plain`
- `--check` (wyjście 1=przeterminowane/brak, 2=wygasające)
- `--probe` (sonda na żywo skonfigurowanych profili uwierzytelniania)
- `--probe-provider <name>`
- `--probe-profile <id>` (powtórzenia lub lista rozdzielona przecinkami)
- `--probe-timeout <ms>`
- `--probe-concurrency <n>`
- `--probe-max-tokens <n>`

Zawsze zawiera przegląd uwierzytelniania i status wygaśnięcia OAuth dla profili w magazynie uwierzytelniania.
`--probe` uruchamia żądania na żywo (może zużywać tokeny i wywoływać limity).

### `models set <model>`

Ustaw `agents.defaults.model.primary`.

### `models set-image <model>`

Ustaw `agents.defaults.imageModel.primary`.

### `models aliases list|add|remove`

Opcje:

- `list`: `--json`, `--plain`
- `add <alias> <model>`
- `remove <alias>`

### `models fallbacks list|add|remove|clear`

Opcje:

- `list`: `--json`, `--plain`
- `add <model>`
- `remove <model>`
- `clear`

### `models image-fallbacks list|add|remove|clear`

Opcje:

- `list`: `--json`, `--plain`
- `add <model>`
- `remove <model>`
- `clear`

### `models scan`

Opcje:

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

Opcje:

- `add`: interaktywny pomocnik uwierzytelniania
- `setup-token`: `--provider <name>` (domyślnie `anthropic`), `--yes`
- `paste-token`: `--provider <name>`, `--profile-id <id>`, `--expires-in <duration>`

### `models auth order get|set|clear`

Opcje:

- `get`: `--provider <name>`, `--agent <id>`, `--json`
- `set`: `--provider <name>`, `--agent <id>`, `<profileIds...>`
- `clear`: `--provider <name>`, `--agent <id>`

## System

### `system event`

Kolejkowanie zdarzenia systemowego i opcjonalne wyzwolenie heartbeat (RPC Gateway).

Wymagane:

- `--text <text>`

Opcje:

- `--mode <now|next-heartbeat>`
- `--json`
- `--url`, `--token`, `--timeout`, `--expect-final`

### `system heartbeat last|enable|disable`

Sterowanie heartbeat (RPC Gateway).

Opcje:

- `--json`
- `--url`, `--token`, `--timeout`, `--expect-final`

### `system presence`

Lista wpisów obecności systemu (RPC Gateway).

Opcje:

- `--json`
- `--url`, `--token`, `--timeout`, `--expect-final`

## Cron

Zarządzanie zadaniami harmonogramu (RPC Gateway). Zobacz [/automation/cron-jobs](/automation/cron-jobs).

Podpolecenia:

- `cron status [--json]`
- `cron list [--all] [--json]` (domyślnie wyjście tabelaryczne; użyj `--json` dla surowego)
- `cron add` (alias: `create`; wymaga `--name` oraz dokładnie jednego z `--at` | `--every` | `--cron`, oraz dokładnie jednego ładunku `--system-event` | `--message`)
- `cron edit <id>` (łatanie pól)
- `cron rm <id>` (aliasy: `remove`, `delete`)
- `cron enable <id>`
- `cron disable <id>`
- `cron runs --id <id> [--limit <n>]`
- `cron run <id> [--force]`

Wszystkie polecenia `cron` akceptują `--url`, `--token`, `--timeout`, `--expect-final`.

## Host węzła

`node` uruchamia **bezgłowy host węzła** lub zarządza nim jako usługą w tle. Zobacz
[`openclaw node`](/cli/node).

Podpolecenia:

- `node run --host <gateway-host> --port 18789`
- `node status`
- `node install [--host <gateway-host>] [--port <port>] [--tls] [--tls-fingerprint <sha256>] [--node-id <id>] [--display-name <name>] [--runtime <node|bun>] [--force]`
- `node uninstall`
- `node stop`
- `node restart`

## Nodes

`nodes` komunikuje się z Gateway i celuje w sparowane węzły. Zobacz [/nodes](/nodes).

Typowe opcje:

- `--url`, `--token`, `--timeout`, `--json`

Podpolecenia:

- `nodes status [--connected] [--last-connected <duration>]`
- `nodes describe --node <id|name|ip>`
- `nodes list [--connected] [--last-connected <duration>]`
- `nodes pending`
- `nodes approve <requestId>`
- `nodes reject <requestId>`
- `nodes rename --node <id|name|ip> --name <displayName>`
- `nodes invoke --node <id|name|ip> --command <command> [--params <json>] [--invoke-timeout <ms>] [--idempotency-key <key>]`
- `nodes run --node <id|name|ip> [--cwd <path>] [--env KEY=VAL] [--command-timeout <ms>] [--needs-screen-recording] [--invoke-timeout <ms>] <command...>` (węzeł mac lub bezgłowy host węzła)
- `nodes notify --node <id|name|ip> [--title <text>] [--body <text>] [--sound <name>] [--priority <passive|active|timeSensitive>] [--delivery <system|overlay|auto>] [--invoke-timeout <ms>]` (tylko mac)

Kamera:

- `nodes camera list --node <id|name|ip>`
- `nodes camera snap --node <id|name|ip> [--facing front|back|both] [--device-id <id>] [--max-width <px>] [--quality <0-1>] [--delay-ms <ms>] [--invoke-timeout <ms>]`
- `nodes camera clip --node <id|name|ip> [--facing front|back] [--device-id <id>] [--duration <ms|10s|1m>] [--no-audio] [--invoke-timeout <ms>]`

Canvas + ekran:

- `nodes canvas snapshot --node <id|name|ip> [--format png|jpg|jpeg] [--max-width <px>] [--quality <0-1>] [--invoke-timeout <ms>]`
- `nodes canvas present --node <id|name|ip> [--target <urlOrPath>] [--x <px>] [--y <px>] [--width <px>] [--height <px>] [--invoke-timeout <ms>]`
- `nodes canvas hide --node <id|name|ip> [--invoke-timeout <ms>]`
- `nodes canvas navigate <url> --node <id|name|ip> [--invoke-timeout <ms>]`
- `nodes canvas eval [<js>] --node <id|name|ip> [--js <code>] [--invoke-timeout <ms>]`
- `nodes canvas a2ui push --node <id|name|ip> (--jsonl <path> | --text <text>) [--invoke-timeout <ms>]`
- `nodes canvas a2ui reset --node <id|name|ip> [--invoke-timeout <ms>]`
- `nodes screen record --node <id|name|ip> [--screen <index>] [--duration <ms|10s>] [--fps <n>] [--no-audio] [--out <path>] [--invoke-timeout <ms>]`

Lokalizacja:

- `nodes location get --node <id|name|ip> [--max-age <ms>] [--accuracy <coarse|balanced|precise>] [--location-timeout <ms>] [--invoke-timeout <ms>]`

## Przeglądarka

CLI sterowania przeglądarką (dedykowane Chrome/Brave/Edge/Chromium). Zobacz [`openclaw browser`](/cli/browser) oraz [narzędzie Browser](/tools/browser).

Typowe opcje:

- `--url`, `--token`, `--timeout`, `--json`
- `--browser-profile <name>`

Zarządzanie:

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

Inspekcja:

- `browser screenshot [targetId] [--full-page] [--ref <ref>] [--element <selector>] [--type png|jpeg]`
- `browser snapshot [--format aria|ai] [--target-id <id>] [--limit <n>] [--interactive] [--compact] [--depth <n>] [--selector <sel>] [--out <path>]`

Akcje:

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

## Wyszukiwanie dokumentacji

### `docs [query...]`

Wyszukiwanie w indeksie dokumentacji na żywo.

## TUI

### `tui`

Otwarcie interfejsu terminalowego połączonego z Gateway.

Opcje:

- `--url <url>`
- `--token <token>`
- `--password <password>`
- `--session <key>`
- `--deliver`
- `--thinking <level>`
- `--message <text>`
- `--timeout-ms <ms>` (domyślnie `agents.defaults.timeoutSeconds`)
- `--history-limit <n>`
