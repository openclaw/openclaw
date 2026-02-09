---
summary: "CLI Gateway OpenClaw (`openclaw gateway`) — uruchamianie, zapytania i wykrywanie bram"
read_when:
  - Uruchamianie Gateway z CLI (dev lub serwery)
  - Debugowanie uwierzytelniania Gateway, trybów bindowania i łączności
  - Wykrywanie bram przez Bonjour (LAN + tailnet)
title: "gateway"
---

# CLI Gateway

Gateway to serwer WebSocket OpenClaw (kanały, węzły, sesje, hooki).

Podkomendy na tej stronie znajdują się pod `openclaw gateway …`.

Powiązana dokumentacja:

- [/gateway/bonjour](/gateway/bonjour)
- [/gateway/discovery](/gateway/discovery)
- [/gateway/configuration](/gateway/configuration)

## Uruchom Gateway

Uruchom lokalny proces Gateway:

```bash
openclaw gateway
```

Dodatkowe informacje pochodzące ze streszczonego uzasadnienia umieszczenia w wykazie przedstawionego przez Komitet Sankcji:

```bash
openclaw gateway run
```

Uwagi:

- Domyślnie Gateway odmawia uruchomienia, chyba że `gateway.mode=local` jest ustawione w `~/.openclaw/openclaw.json`. Użyj `--allow-unconfigured` do uruchomień ad-hoc/dev.
- Wiązanie poza loopback bez uwierzytelniania jest blokowane (bariera bezpieczeństwa).
- `SIGUSR1` wyzwala restart w procesie po autoryzacji (włącz `commands.restart` lub użyj narzędzia gateway / config apply/update).
- Procedury `SIGINT`/`SIGTERM` zatrzymują proces gateway, ale nie przywracają niestandardowego stanu terminala. Jeśli owijasz CLI w TUI lub tryb surowy wejścia, przywróć terminal przed wyjściem.

### Opcje

- `--port <port>`: port WebSocket (wartość domyślna pochodzi z konfiguracji/zmiennych środowiskowych; zwykle `18789`).
- `--bind <loopback|lan|tailnet|auto|custom>`: tryb bindowania nasłuchiwania.
- `--auth <token|password>`: nadpisanie trybu uwierzytelniania.
- `--token <token>`: nadpisanie tokenu (ustawia także `OPENCLAW_GATEWAY_TOKEN` dla procesu).
- `--password <password>`: nadpisanie hasła (ustawia także `OPENCLAW_GATEWAY_PASSWORD` dla procesu).
- `--tailscale <off|serve|funnel>`: udostępnij Gateway przez Tailscale.
- `--tailscale-reset-on-exit`: resetuj konfigurację Tailscale serve/funnel przy zamykaniu.
- `--allow-unconfigured`: pozwól na start gateway bez `gateway.mode=local` w konfiguracji.
- `--dev`: utwórz konfigurację dev + obszar roboczy, jeśli brak (pomija BOOTSTRAP.md).
- `--reset`: zresetuj konfigurację dev + poświadczenia + sesje + obszar roboczy (wymaga `--dev`).
- `--force`: zakończ dowolny istniejący nasłuch na wybranym porcie przed startem.
- `--verbose`: szczegółowe logi.
- `--claude-cli-logs`: pokazuj w konsoli wyłącznie logi claude-cli (oraz włącz jego stdout/stderr).
- `--ws-log <auto|full|compact>`: styl logów websocket (domyślnie `auto`).
- `--compact`: alias dla `--ws-log compact`.
- `--raw-stream`: zapisuj surowe zdarzenia strumienia modelu do jsonl.
- `--raw-stream-path <path>`: ścieżka do pliku jsonl surowego strumienia.

## Zapytania do działającego Gateway

Wszystkie polecenia zapytań używają RPC WebSocket.

Tryby wyjścia:

- Domyślny: czytelny dla człowieka (kolorowany w TTY).
- `--json`: czytelny maszynowo JSON (bez stylowania/spinnera).
- `--no-color` (lub `NO_COLOR=1`): wyłącz ANSI, zachowując układ czytelny dla człowieka.

Wspólne opcje (tam, gdzie obsługiwane):

- `--url <url>`: URL WebSocket Gateway.
- `--token <token>`: token Gateway.
- `--password <password>`: hasło Gateway.
- `--timeout <ms>`: limit czasu/budżet (różni się w zależności od polecenia).
- `--expect-final`: czekaj na „finalną” odpowiedź (wywołania agenta).

Uwaga: gdy ustawisz `--url`, CLI nie korzysta z poświadczeń z konfiguracji ani środowiska.
Przekaż jawnie `--token` lub `--password`. Brak jawnych poświadczeń jest błędem.

### `gateway health`

```bash
openclaw gateway health --url ws://127.0.0.1:18789
```

### `gateway status`

`gateway status` pokazuje usługę Gateway (launchd/systemd/schtasks) oraz opcjonalną sondę RPC.

```bash
openclaw gateway status
openclaw gateway status --json
```

Opcje:

- `--url <url>`: nadpisz URL sondy.
- `--token <token>`: uwierzytelnianie tokenem dla sondy.
- `--password <password>`: uwierzytelnianie hasłem dla sondy.
- `--timeout <ms>`: limit czasu sondy (domyślnie `10000`).
- `--no-probe`: pomiń sondę RPC (widok tylko usługi).
- `--deep`: skanuj także usługi na poziomie systemowym.

### `gateway probe`

`gateway probe` to polecenie „debuguj wszystko”. Zawsze sonduje:

- skonfigurowany zdalny gateway (jeśli ustawiony) oraz
- localhost (loopback) **nawet jeśli zdalny jest skonfigurowany**.

Jeśli dostępnych jest wiele bram, wyświetla wszystkie. Wiele bram jest obsługiwanych przy użyciu izolowanych profili/portów (np. bot ratunkowy), ale większość instalacji nadal uruchamia pojedynczą bramę.

```bash
openclaw gateway probe
openclaw gateway probe --json
```

#### Zdalnie przez SSH (parytet aplikacji macOS)

Tryb „Remote over SSH” w aplikacji macOS używa lokalnego przekierowania portów, dzięki czemu zdalny gateway (który może być związany tylko z loopback) staje się dostępny pod `ws://127.0.0.1:<port>`.

Odpowiednik w CLI:

```bash
openclaw gateway probe --ssh user@gateway-host
```

Opcje:

- `--ssh <target>`: `user@host` lub `user@host:port` (port domyślnie `22`).
- `--ssh-identity <path>`: plik tożsamości.
- `--ssh-auto`: wybierz pierwszy wykryty host gateway jako cel SSH (tylko LAN/WAB).

Konfiguracja (opcjonalna, używana jako domyślne):

- `gateway.remote.sshTarget`
- `gateway.remote.sshIdentity`

### `gateway call <method>`

Niski poziom pomocnika RPC.

```bash
openclaw gateway call status
openclaw gateway call logs.tail --params '{"sinceMs": 60000}'
```

## Zarządzanie usługą Gateway

```bash
openclaw gateway install
openclaw gateway start
openclaw gateway stop
openclaw gateway restart
openclaw gateway uninstall
```

Uwagi:

- `gateway install` obsługuje `--port`, `--runtime`, `--token`, `--force`, `--json`.
- Polecenia cyklu życia akceptują `--json` do skryptowania.

## Wykrywanie bram (Bonjour)

`gateway discover` skanuje w poszukiwaniu beaconów Gateway (`_openclaw-gw._tcp`).

- Multicast DNS-SD: `local.`
- Unicast DNS-SD (Wide-Area Bonjour): wybierz domenę (przykład: `openclaw.internal.`) i skonfiguruj split DNS + serwer DNS; zobacz [/gateway/bonjour](/gateway/bonjour)

Tylko bramy z włączonym wykrywaniem Bonjour (domyślnie) reklamują beacon.

Rekordy wykrywania Wide-Area zawierają (TXT):

- `role` (wskazówka roli gateway)
- `transport` (wskazówka transportu, np. `gateway`)
- `gatewayPort` (port WebSocket, zwykle `18789`)
- `sshPort` (port SSH; domyślnie `22`, jeśli nieobecny)
- `tailnetDns` (nazwa hosta MagicDNS, gdy dostępna)
- `gatewayTls` / `gatewayTlsSha256` (TLS włączone + odcisk certyfikatu)
- `cliPath` (opcjonalna wskazówka dla instalacji zdalnych)

### `gateway discover`

```bash
openclaw gateway discover
```

Opcje:

- `--timeout <ms>`: limit czasu na polecenie (przeglądanie/rozwiązywanie); domyślnie `2000`.
- `--json`: wyjście czytelne maszynowo (wyłącza także stylowanie/spinner).

Przykłady:

```bash
openclaw gateway discover --timeout 4000
openclaw gateway discover --json | jq '.beacons[].wsUrl'
```
