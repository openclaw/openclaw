---
summary: "Runbook dla usługi Gateway, jej cyklu życia i operacji"
read_when:
  - Uruchamianie lub debugowanie procesu gateway
title: "Runbook Gateway"
---

# Runbook usługi Gateway

Ostatnia aktualizacja: 2025-12-09

## Czym to jest

- Zawsze uruchomiony proces, który posiada pojedyncze połączenie Baileys/Telegram oraz płaszczyznę sterowania/zdarzeń.
- Zastępuje starsze polecenie `gateway`. Punkt wejścia CLI: `openclaw gateway`.
- Uruchomienie do zatrzymania; wyjdzie poza zero przy błędach śmiertelnych, więc przełożony ponownie je uruchomi.

## Jak uruchomić (lokalnie)

```bash
openclaw gateway --port 18789
# for full debug/trace logs in stdio:
openclaw gateway --port 18789 --verbose
# if the port is busy, terminate listeners then start:
openclaw gateway --force
# dev loop (auto-reload on TS changes):
pnpm gateway:watch
```

- Hot reload konfiguracji obserwuje `~/.openclaw/openclaw.json` (lub `OPENCLAW_CONFIG_PATH`).
  - Tryb domyślny: `gateway.reload.mode="hybrid"` (bezpieczne zmiany stosowane „na gorąco”, restart przy krytycznych).
  - Hot reload używa restartu w procesie przez **SIGUSR1**, gdy jest to potrzebne.
  - Wyłącz za pomocą `gateway.reload.mode="off"`.
- Wiąże płaszczyznę sterowania WebSocket z `127.0.0.1:<port>` (domyślnie 18789).
- Ten sam port obsługuje także HTTP (UI sterowania, hooki, A2UI). Multipleks jednego portu.
  - OpenAI Chat Completions (HTTP): [`/v1/chat/completions`](/gateway/openai-http-api).
  - OpenResponses (HTTP): [`/v1/responses`](/gateway/openresponses-http-api).
  - Tools Invoke (HTTP): [`/tools/invoke`](/gateway/tools-invoke-http-api).
- Domyślnie uruchamia serwer plików Canvas na `canvasHost.port` (domyślnie `18793`), serwując `http://<gateway-host>:18793/__openclaw__/canvas/` z `~/.openclaw/workspace/canvas`. Wyłącz za pomocą `canvasHost.enabled=false` lub `OPENCLAW_SKIP_CANVAS_HOST=1`.
- Loguje do stdout; użyj launchd/systemd, aby utrzymać działanie i rotować logi.
- Przekaż `--verbose`, aby dublować logowanie debug (handshake’i, req/res, zdarzenia) z pliku logu do stdio podczas rozwiązywania problemów.
- `--force` używa `lsof` do znalezienia nasłuchów na wybranym porcie, wysyła SIGTERM, loguje, co zostało ubite, a następnie uruchamia gateway (szybko kończy się niepowodzeniem, jeśli brakuje `lsof`).
- Jeśli działa pod nadzorcą (launchd/systemd/tryb procesu potomnego aplikacji macOS), zatrzymanie/restart zwykle wysyła **SIGTERM**; starsze buildy mogą raportować to jako `pnpm` `ELIFECYCLE` z kodem wyjścia **143** (SIGTERM), co jest normalnym zamknięciem, a nie awarią.
- **SIGUSR1** wyzwala restart w procesie, gdy jest autoryzowany (narzędzie Gateway/zastosowanie konfiguracji/aktualizacja lub włącz `commands.restart` dla ręcznych restartów).
- Uwierzytelnianie Gateway jest domyślnie wymagane: ustaw `gateway.auth.token` (lub `OPENCLAW_GATEWAY_TOKEN`) albo `gateway.auth.password`. Klienci muszą wysyłać `connect.params.auth.token/password`, chyba że używają tożsamości Tailscale Serve.
- Kreator domyślnie generuje token, nawet na pętli zwrotnej.
- Priorytet portów: `--port` > `OPENCLAW_GATEWAY_PORT` > `gateway.port` > domyślny `18789`.

## Zdalny dostęp

- Preferowane Tailscale/VPN; w przeciwnym razie tunel SSH:

  ```bash
  ssh -N -L 18789:127.0.0.1:18789 user@host
  ```

- Następnie klienci łączą się z `ws://127.0.0.1:18789` przez tunel.

- Jeśli skonfigurowano token, klienci muszą dołączyć go w `connect.params.auth.token`, nawet przez tunel.

## Wiele gatewayów (ten sam host)

Zwykle niepotrzebne: jeden Gateway może obsługiwać wiele kanałów komunikacyjnych i agentów. Używaj wielu Gatewayów tylko dla redundancji lub ścisłej izolacji (np. bot ratunkowy).

Obsługiwane, jeśli odizolujesz stan + konfigurację i użyjesz unikatowych portów. Pełny przewodnik: [Multiple gateways](/gateway/multiple-gateways).

Nazwy usług są świadome profilu:

- macOS: `bot.molt.<profile>` (starszy `com.openclaw.*` może nadal istnieć)
- Linux: `openclaw-gateway-<profile>.service`
- Windows: `OpenClaw Gateway (<profile>)`

Metadane instalacji są osadzone w konfiguracji usługi:

- `OPENCLAW_SERVICE_MARKER=openclaw`
- `OPENCLAW_SERVICE_KIND=gateway`
- `OPENCLAW_SERVICE_VERSION=<version>`

Wzorzec Rescue-Bot: utrzymuj drugi Gateway w izolacji z własnym profilem, katalogiem stanu, obszarem roboczym i rozstawem bazowych portów. Pełny przewodnik: [Rescue-bot guide](/gateway/multiple-gateways#rescue-bot-guide).

### Profil deweloperski (`--dev`)

Szybka ścieżka: uruchom w pełni odizolowaną instancję deweloperską (konfiguracja/stan/obszar roboczy) bez naruszania głównej konfiguracji.

```bash
openclaw --dev setup
openclaw --dev gateway --allow-unconfigured
# then target the dev instance:
openclaw --dev status
openclaw --dev health
```

Domyślne wartości (można nadpisać przez env/flagi/konfigurację):

- `OPENCLAW_STATE_DIR=~/.openclaw-dev`
- `OPENCLAW_CONFIG_PATH=~/.openclaw-dev/openclaw.json`
- `OPENCLAW_GATEWAY_PORT=19001` (Gateway WS + HTTP)
- port usługi sterowania przeglądarką = `19003` (pochodny: `gateway.port+2`, tylko pętla zwrotna)
- `canvasHost.port=19005` (pochodny: `gateway.port+4`)
- `agents.defaults.workspace` domyślnie staje się `~/.openclaw/workspace-dev`, gdy uruchamiasz `setup`/`onboard` pod `--dev`.

Porty pochodne (reguły kciuka):

- Port bazowy = `gateway.port` (lub `OPENCLAW_GATEWAY_PORT` / `--port`)
- port usługi sterowania przeglądarką = baza + 2 (tylko pętla zwrotna)
- `canvasHost.port = base + 4` (lub `OPENCLAW_CANVAS_HOST_PORT` / nadpisanie w konfiguracji)
- Porty CDP profilu przeglądarki są przydzielane automatycznie od `browser.controlPort + 9 .. + 108` (utrwalane per profil).

Lista kontrolna per instancję:

- unikatowy `gateway.port`
- unikatowy `OPENCLAW_CONFIG_PATH`
- unikatowy `OPENCLAW_STATE_DIR`
- unikatowy `agents.defaults.workspace`
- osobne numery WhatsApp (jeśli używasz WA)

Instalacja usługi per profil:

```bash
openclaw --profile main gateway install
openclaw --profile rescue gateway install
```

Przykład:

```bash
OPENCLAW_CONFIG_PATH=~/.openclaw/a.json OPENCLAW_STATE_DIR=~/.openclaw-a openclaw gateway --port 19001
OPENCLAW_CONFIG_PATH=~/.openclaw/b.json OPENCLAW_STATE_DIR=~/.openclaw-b openclaw gateway --port 19002
```

## Protokół (widok operatora)

- Pełna dokumentacja: [Gateway protocol](/gateway/protocol) oraz [Bridge protocol (legacy)](/gateway/bridge-protocol).
- Obowiązkowa pierwsza ramka od klienta: `req {type:"req", id, method:"connect", params:{minProtocol,maxProtocol,client:{id,displayName?,version,platform,deviceFamily?,modelIdentifier?,mode,instanceId?}, caps, auth?, locale?, userAgent? } }`.
- Gateway odpowiada `res {type:"res", id, ok:true, payload:hello-ok }` (lub `ok:false` z błędem, a następnie zamyka).
- Po handshake’u:
  - Żądania: `{type:"req", id, method, params}` → `{type:"res", id, ok, payload|error}`
  - Zdarzenia: `{type:"event", event, payload, seq?, stateVersion?}`
- Strukturalne wpisy obecności: `{host, ip, version, platform?, deviceFamily?, modelIdentifier?, mode, lastInputSeconds?, ts, reason?, tags?[], instanceId? }` (dla klientów WS, `instanceId` pochodzi z `connect.client.instanceId`).
- Odpowiedzi `agent` są dwuetapowe: najpierw potwierdzenie `res` `{runId,status:"accepted"}`, a następnie końcowe `res` `{runId,status:"ok"|"error",summary}` po zakończeniu wykonania; strumieniowane wyjście dociera jako `event:"agent"`.

## Metody (zestaw początkowy)

- `health` — pełna migawka zdrowia (ten sam kształt co `openclaw health --json`).
- `status` — krótkie podsumowanie.
- `system-presence` — bieżąca lista obecności.
- `system-event` — opublikuj notatkę obecności/systemową (strukturalną).
- `send` — wyślij wiadomość przez aktywne kanały.
- `agent` — uruchom turę agenta (strumieniuje zdarzenia z powrotem na tym samym połączeniu).
- `node.list` — lista sparowanych + aktualnie podłączonych węzłów (zawiera `caps`, `deviceFamily`, `modelIdentifier`, `paired`, `connected` oraz reklamowane `commands`).
- `node.describe` — opis węzła (możliwości + obsługiwane polecenia `node.invoke`; działa dla węzłów sparowanych oraz aktualnie podłączonych niesparowanych).
- `node.invoke` — wywołaj polecenie na węźle (np. `canvas.*`, `camera.*`).
- `node.pair.*` — cykl życia parowania (`request`, `list`, `approve`, `reject`, `verify`).

Zobacz także: [Presence](/concepts/presence), aby dowiedzieć się, jak obecność jest wytwarzana/deduplikowana i dlaczego stabilny `client.instanceId` ma znaczenie.

## Zdarzenia

- `agent` — strumieniowane zdarzenia narzędzia/wyjścia z uruchomienia agenta (oznaczone sekwencją).
- `presence` — aktualizacje obecności (delty z stateVersion) wysyłane do wszystkich podłączonych klientów.
- `tick` — okresowy keepalive/no-op potwierdzający żywotność.
- `shutdown` — Gateway kończy działanie; ładunek zawiera `reason` oraz opcjonalne `restartExpectedMs`. Klienci powinni ponownie się połączyć.

## Integracja WebChat

- WebChat to natywny interfejs SwiftUI, który komunikuje się bezpośrednio z Gateway WebSocket w zakresie historii, wysyłania, przerywania i zdarzeń.
- Zdalne użycie przechodzi przez ten sam tunel SSH/Tailscale; jeśli skonfigurowano token gateway, klient dołącza go podczas `connect`.
- Aplikacja macOS łączy się przez pojedynczy WS (połączenie współdzielone); hydratuje obecność z początkowej migawki i nasłuchuje zdarzeń `presence`, aby aktualizować UI.

## Typowanie i walidacja

- Serwer waliduje każdą przychodzącą ramkę za pomocą AJV względem JSON Schema emitowanego z definicji protokołu.
- Klienci (TS/Swift) konsumują generowane typy (TS bezpośrednio; Swift przez generator repozytorium).
- Definicje protokołu są jedynym źródłem prawdy; regeneruj schematy/modele za pomocą:
  - `pnpm protocol:gen`
  - `pnpm protocol:gen:swift`

## Migawka połączenia

- `hello-ok` zawiera `snapshot` z `presence`, `health`, `stateVersion` oraz `uptimeMs` plus `policy {maxPayload,maxBufferedBytes,tickIntervalMs}`, aby klienci mogli renderować natychmiast bez dodatkowych żądań.
- `health`/`system-presence` pozostają dostępne do ręcznego odświeżenia, ale nie są wymagane w momencie połączenia.

## Kody błędów (kształt res.error)

- Błędy używają `{ code, message, details?, retryable?, retryAfterMs? }`.
- Standardowe kody:
  - `NOT_LINKED` — WhatsApp nie jest uwierzytelniony.
  - `AGENT_TIMEOUT` — agent nie odpowiedział w skonfigurowanym czasie.
  - `INVALID_REQUEST` — nieudana walidacja schematu/parametrów.
  - `UNAVAILABLE` — Gateway jest w trakcie zamykania lub zależność jest niedostępna.

## Zachowanie keepalive

- Zdarzenia `tick` (lub ping/pong WS) są emitowane okresowo, aby klienci wiedzieli, że Gateway żyje nawet przy braku ruchu.
- Potwierdzenia wysyłek/agentów pozostają oddzielnymi odpowiedziami; nie przeciążaj ticków dla wysyłek.

## Odtwarzanie / luki

- Zdarzenia nie są odtwarzane. Klienci wykrywają luki sekwencji i powinni odświeżyć (`health` + `system-presence`) przed kontynuacją. WebChat i klienci macOS automatycznie odświeżają przy wykryciu luki.

## Nadzór (przykład macOS)

- Użyj launchd, aby utrzymać usługę przy życiu:
  - Program: ścieżka do `openclaw`
  - Argumenty: `gateway`
  - KeepAlive: true
  - StandardOut/Err: ścieżki plików lub `syslog`
- Przy awarii launchd restartuje; fatalna błędna konfiguracja powinna powodować dalsze kończenie się procesu, aby operator to zauważył.
- LaunchAgents są per-użytkownik i wymagają zalogowanej sesji; dla konfiguracji headless użyj niestandardowego LaunchDaemon (nie jest dostarczany).
  - `openclaw gateway install` zapisuje `~/Library/LaunchAgents/bot.molt.gateway.plist`
    (lub `bot.molt.<profile>.plist`; starszy `com.openclaw.*` jest czyszczony).
  - `openclaw doctor` audytuje konfigurację LaunchAgent i może ją zaktualizować do bieżących domyślnych wartości.

## Zarządzanie usługą Gateway (CLI)

Użyj CLI Gateway do instalacji/uruchamiania/zatrzymywania/restartu/statusu:

```bash
openclaw gateway status
openclaw gateway install
openclaw gateway stop
openclaw gateway restart
openclaw logs --follow
```

Uwagi:

- `gateway status` domyślnie sonduje RPC Gateway, używając rozwiązanego portu/konfiguracji usługi (nadpisz za pomocą `--url`).
- `gateway status --deep` dodaje skany na poziomie systemu (LaunchDaemons/jednostki systemowe).
- `gateway status --no-probe` pomija sondę RPC (przydatne, gdy sieć nie działa).
- `gateway status --json` jest stabilne do skryptów.
- `gateway status` raportuje **czas działania nadzorcy** (działanie launchd/systemd) oddzielnie od **osiągalności RPC** (połączenie WS + RPC status).
- `gateway status` wypisuje ścieżkę konfiguracji + cel sondy, aby uniknąć zamieszania „localhost vs bind LAN” i niedopasowań profilu.
- `gateway status` dołącza ostatnią linię błędu gateway, gdy usługa wygląda na uruchomioną, ale port jest zamknięty.
- `logs` śledzi plik logu Gateway przez RPC (bez ręcznego `tail`/`grep`).
- Jeśli wykryte zostaną inne usługi podobne do gateway, CLI ostrzega, chyba że są to usługi profilu OpenClaw.
  Nadal zalecamy **jeden gateway na maszynę** dla większości konfiguracji; użyj odizolowanych profili/portów dla redundancji lub bota ratunkowego. Zobacz [Multiple gateways](/gateway/multiple-gateways).
  - Sprzątanie: `openclaw gateway uninstall` (bieżąca usługa) oraz `openclaw doctor` (migracje starszych wersji).
- `gateway install` jest no-op, gdy już zainstalowane; użyj `openclaw gateway install --force`, aby przeinstalować (zmiany profilu/env/ścieżki).

Dołączona aplikacja macOS:

- OpenClaw.app może dołączać oparty na Node relay gateway i instalować per-użytkownik LaunchAgent oznaczony
  `bot.molt.gateway` (lub `bot.molt.<profile>`; starsze etykiety `com.openclaw.*` nadal odinstalowują się poprawnie).
- Aby zatrzymać czysto, użyj `openclaw gateway stop` (lub `launchctl bootout gui/$UID/bot.molt.gateway`).
- Aby zrestartować, użyj `openclaw gateway restart` (lub `launchctl kickstart -k gui/$UID/bot.molt.gateway`).
  - `launchctl` działa tylko wtedy, gdy LaunchAgent jest zainstalowany; w przeciwnym razie najpierw użyj `openclaw gateway install`.
  - Zastąp etykietę `bot.molt.<profile>`, gdy uruchamiasz nazwany profil.

## Nadzór (jednostka użytkownika systemd)

OpenClaw domyślnie instaluje **usługę użytkownika systemd** na Linux/WSL2. Zalecamy
usługi użytkownika dla maszyn jednoosobowych (prostsze środowisko, konfiguracja per użytkownik).
Użyj **usługi systemowej** dla serwerów wieloużytkownikowych lub zawsze włączonych (bez wymaganego lingering, wspólny nadzór).

`openclaw gateway install` zapisuje jednostkę użytkownika. `openclaw doctor` audytuje
jednostkę i może ją zaktualizować, aby odpowiadała aktualnie zalecanym domyślnym ustawieniom.

Utwórz `~/.config/systemd/user/openclaw-gateway[-<profile>].service`:

```
[Unit]
Description=OpenClaw Gateway (profile: <profile>, v<version>)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/local/bin/openclaw gateway --port 18789
Restart=always
RestartSec=5
Environment=OPENCLAW_GATEWAY_TOKEN=
WorkingDirectory=/home/youruser

[Install]
WantedBy=default.target
```

Włącz lingering (wymagane, aby usługa użytkownika przetrwała wylogowanie/bezczynność):

```
sudo loginctl enable-linger youruser
```

Onboarding uruchamia to na Linux/WSL2 (może poprosić o sudo; zapisuje `/var/lib/systemd/linger`).
Następnie włącz usługę:

```
systemctl --user enable --now openclaw-gateway[-<profile>].service
```

**Alternatywa (usługa systemowa)** — dla serwerów zawsze włączonych lub wieloużytkownikowych możesz
zainstalować jednostkę **systemową** systemd zamiast jednostki użytkownika (brak potrzeby lingering).
Utwórz `/etc/systemd/system/openclaw-gateway[-<profile>].service` (skopiuj jednostkę powyżej,
przełącz `WantedBy=multi-user.target`, ustaw `User=` + `WorkingDirectory=`), a następnie:

```
sudo systemctl daemon-reload
sudo systemctl enable --now openclaw-gateway[-<profile>].service
```

## Windows (WSL2)

Instalacje na Windows powinny używać **WSL2** i postępować zgodnie z powyższą sekcją Linux systemd.

## Kontrole operacyjne

- Żywotność: otwórz WS i wyślij `req:connect` → oczekuj `res` z `payload.type="hello-ok"` (z migawką).
- Gotowość: wywołaj `health` → oczekuj `ok: true` oraz połączonego kanału w `linkChannel` (jeśli dotyczy).
- Debug: subskrybuj zdarzenia `tick` i `presence`; upewnij się, że `status` pokazuje wiek połączenia/uwierzytelnienia; wpisy obecności pokazują host Gateway i podłączonych klientów.

## Gwarancje bezpieczeństwa

- Domyślnie zakładaj jeden Gateway na host; jeśli uruchamiasz wiele profili, izoluj porty/stan i celuj w właściwą instancję.
- Brak fallbacku do bezpośrednich połączeń Baileys; jeśli Gateway jest niedostępny, wysyłki kończą się natychmiast niepowodzeniem.
- Ramki inne niż pierwsza ramka połączenia lub niepoprawny JSON są odrzucane, a gniazdo jest zamykane.
- Łagodne zamknięcie: emituj zdarzenie `shutdown` przed zamknięciem; klienci muszą obsłużyć zamknięcie + ponowne połączenie.

## Pomocnicy CLI

- `openclaw gateway health|status` — żądanie health/status przez WS Gateway.
- `openclaw message send --target <num> --message "hi" [--media ...]` — wysyłka przez Gateway (idempotentna dla WhatsApp).
- `openclaw agent --message "hi" --to <num>` — uruchom turę agenta (domyślnie czeka na wynik końcowy).
- `openclaw gateway call <method> --params '{"k":"v"}'` — surowy wywoływacz metod do debugowania.
- `openclaw gateway stop|restart` — zatrzymaj/zrestartuj nadzorowaną usługę gateway (launchd/systemd).
- Podkomendy pomocnicze Gateway zakładają działający gateway na `--url`; nie uruchamiają już automatycznie nowego.

## Wskazówki migracyjne

- Wycofaj użycia `openclaw gateway` oraz starszego portu sterowania TCP.
- Zaktualizuj klientów, aby mówili protokołem WS z obowiązkowym connect i strukturalną obecnością.
