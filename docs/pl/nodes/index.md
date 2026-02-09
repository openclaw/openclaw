---
summary: "Węzły: parowanie, możliwości, uprawnienia oraz pomocniki CLI dla canvas/kamery/ekranu/systemu"
read_when:
  - Parowanie węzłów iOS/Android z gatewayem
  - Używanie canvas/kamery węzła jako kontekstu agenta
  - Dodawanie nowych poleceń węzła lub pomocników CLI
title: "Nodes"
---

# Nodes

**Węzeł** to urządzenie towarzyszące (macOS/iOS/Android/headless), które łączy się z **WebSocket** Gateway (ten sam port co operatorzy) z użyciem `role: "node"` i udostępnia powierzchnię poleceń (np. `canvas.*`, `camera.*`, `system.*`) przez `node.invoke`. Szczegóły protokołu: [Gateway protocol](/gateway/protocol).

Transport starszy: [Bridge protocol](/gateway/bridge-protocol) (TCP JSONL; przestarzały/usunięty dla bieżących węzłów).

macOS może również działać w **trybie węzła**: aplikacja w pasku menu łączy się z serwerem WS Gateway i udostępnia lokalne polecenia canvas/kamery jako węzeł (dzięki czemu `openclaw nodes …` działa na tym Macu).

Uwagi:

- Węzły są **peryferiami**, a nie gatewayami. Nie uruchamiają usługi gateway.
- Wiadomości z Telegram/WhatsApp/etc. trafiają do **gatewaya**, a nie do węzłów.
- Procedura rozwiązywania problemów: [/nodes/troubleshooting](/nodes/troubleshooting)

## Parowanie + status

**Węzły WS używają parowania urządzeń.** Węzły przedstawiają tożsamość urządzenia podczas `connect`; Gateway
tworzy żądanie parowania urządzenia dla `role: node`. Zatwierdź przez CLI urządzenia (lub UI).

Szybkie CLI:

```bash
openclaw devices list
openclaw devices approve <requestId>
openclaw devices reject <requestId>
openclaw nodes status
openclaw nodes describe --node <idOrNameOrIp>
```

Uwagi:

- `nodes status` oznacza węzeł jako **sparowany**, gdy jego rola parowania urządzenia obejmuje `node`.
- `node.pair.*` (CLI: `openclaw nodes pending/approve/reject`) to oddzielny, należący do gatewaya
  magazyn parowań węzłów; **nie** blokuje on handshake WS `connect`.

## Zdalny host węzła (system.run)

Użyj **hosta węzła**, gdy Gateway działa na jednej maszynie, a chcesz, aby polecenia
wykonywały się na innej. Model nadal komunikuje się z **gatewayem**; gateway
przekazuje wywołania `exec` do **hosta węzła**, gdy wybrano `host=node`.

### Co działa gdzie

- **Host Gateway**: odbiera wiadomości, uruchamia model, routuje wywołania narzędzi.
- **Host węzła**: wykonuje `system.run`/`system.which` na maszynie węzła.
- **Zatwierdzenia**: egzekwowane na hoście węzła przez `~/.openclaw/exec-approvals.json`.

### Uruchom host węzła (pierwszy plan)

Na maszynie węzła:

```bash
openclaw node run --host <gateway-host> --port 18789 --display-name "Build Node"
```

### Zdalny gateway przez tunel SSH (wiązanie loopback)

Jeśli Gateway wiąże się z loopback (`gateway.bind=loopback`, domyślnie w trybie lokalnym),
zdalne hosty węzłów nie mogą połączyć się bezpośrednio. Utwórz tunel SSH i wskaż
hostowi węzła lokalny koniec tunelu.

Przykład (host węzła -> host gateway):

```bash
# Terminal A (keep running): forward local 18790 -> gateway 127.0.0.1:18789
ssh -N -L 18790:127.0.0.1:18789 user@gateway-host

# Terminal B: export the gateway token and connect through the tunnel
export OPENCLAW_GATEWAY_TOKEN="<gateway-token>"
openclaw node run --host 127.0.0.1 --port 18790 --display-name "Build Node"
```

Uwagi:

- Token to `gateway.auth.token` z konfiguracji gatewaya (`~/.openclaw/openclaw.json` na hoście gatewaya).
- `openclaw node run` odczytuje `OPENCLAW_GATEWAY_TOKEN` do uwierzytelniania.

### Uruchom host węzła (usługa)

```bash
openclaw node install --host <gateway-host> --port 18789 --display-name "Build Node"
openclaw node restart
```

### Parowanie + nazwa

Na hoście gatewaya:

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
openclaw nodes list
```

Opcje nazewnictwa:

- `--display-name` na `openclaw node run` / `openclaw node install` (utrwala się w `~/.openclaw/node.json` na węźle).
- `openclaw nodes rename --node <id|name|ip> --name "Build Node"` (nadpisanie po stronie gatewaya).

### Lista dozwolonych poleceń

Zatwierdzenia exec są **per host węzła**. Dodaj wpisy listy dozwolonych z gatewaya:

```bash
openclaw approvals allowlist add --node <id|name|ip> "/usr/bin/uname"
openclaw approvals allowlist add --node <id|name|ip> "/usr/bin/sw_vers"
```

Zatwierdzenia są przechowywane na hoście węzła w `~/.openclaw/exec-approvals.json`.

### Skieruj exec do węzła

Skonfiguruj domyślne (konfiguracja gatewaya):

```bash
openclaw config set tools.exec.host node
openclaw config set tools.exec.security allowlist
openclaw config set tools.exec.node "<id-or-name>"
```

Lub per sesja:

```
/exec host=node security=allowlist node=<id-or-name>
```

Po ustawieniu każde wywołanie `exec` z `host=node` uruchamia się na hoście węzła (z zastrzeżeniem
listy dozwolonych/zatwierdzeń węzła).

Powiązane:

- [Node host CLI](/cli/node)
- [Exec tool](/tools/exec)
- [Exec approvals](/tools/exec-approvals)

## Wywoływanie poleceń

Niskopoziomowo (surowe RPC):

```bash
openclaw nodes invoke --node <idOrNameOrIp> --command canvas.eval --params '{"javaScript":"location.href"}'
```

Istnieją pomocniki wyższego poziomu dla typowych przepływów „przekaż agentowi załącznik MEDIA”.

## Zrzuty ekranu (migawki canvas)

Jeśli węzeł wyświetla Canvas (WebView), `canvas.snapshot` zwraca `{ format, base64 }`.

Pomocnik CLI (zapisuje do pliku tymczasowego i wypisuje `MEDIA:<path>`):

```bash
openclaw nodes canvas snapshot --node <idOrNameOrIp> --format png
openclaw nodes canvas snapshot --node <idOrNameOrIp> --format jpg --max-width 1200 --quality 0.9
```

### Sterowanie canvas

```bash
openclaw nodes canvas present --node <idOrNameOrIp> --target https://example.com
openclaw nodes canvas hide --node <idOrNameOrIp>
openclaw nodes canvas navigate https://example.com --node <idOrNameOrIp>
openclaw nodes canvas eval --node <idOrNameOrIp> --js "document.title"
```

Uwagi:

- `canvas present` akceptuje URL-e lub lokalne ścieżki plików (`--target`), plus opcjonalne `--x/--y/--width/--height` do pozycjonowania.
- `canvas eval` akceptuje wbudowany JS (`--js`) lub argument pozycyjny.

### A2UI (Canvas)

```bash
openclaw nodes canvas a2ui push --node <idOrNameOrIp> --text "Hello"
openclaw nodes canvas a2ui push --node <idOrNameOrIp> --jsonl ./payload.jsonl
openclaw nodes canvas a2ui reset --node <idOrNameOrIp>
```

Uwagi:

- Obsługiwany jest wyłącznie A2UI v0.8 JSONL (v0.9/createSurface jest odrzucany).

## Zdjęcia + wideo (kamera węzła)

Zdjęcia (`jpg`):

```bash
openclaw nodes camera list --node <idOrNameOrIp>
openclaw nodes camera snap --node <idOrNameOrIp>            # default: both facings (2 MEDIA lines)
openclaw nodes camera snap --node <idOrNameOrIp> --facing front
```

Klipy wideo (`mp4`):

```bash
openclaw nodes camera clip --node <idOrNameOrIp> --duration 10s
openclaw nodes camera clip --node <idOrNameOrIp> --duration 3000 --no-audio
```

Uwagi:

- Węzeł musi być **na pierwszym planie** dla `canvas.*` i `camera.*` (wywołania w tle zwracają `NODE_BACKGROUND_UNAVAILABLE`).
- Czas trwania klipu jest ograniczany (obecnie `<= 60s`), aby uniknąć zbyt dużych ładunków base64.
- Android poprosi o uprawnienia `CAMERA`/`RECORD_AUDIO`, gdy to możliwe; odmowa uprawnień kończy się `*_PERMISSION_REQUIRED`.

## Nagrania ekranu (węzły)

Węzły udostępniają `screen.record` (mp4). Przykład:

```bash
openclaw nodes screen record --node <idOrNameOrIp> --duration 10s --fps 10
openclaw nodes screen record --node <idOrNameOrIp> --duration 10s --fps 10 --no-audio
```

Uwagi:

- `screen.record` wymaga, aby aplikacja węzła była na pierwszym planie.
- Android wyświetli systemowy monit o przechwytywanie ekranu przed nagrywaniem.
- Nagrania ekranu są ograniczane do `<= 60s`.
- `--no-audio` wyłącza przechwytywanie mikrofonu (obsługiwane na iOS/Android; macOS używa dźwięku z przechwytywania systemowego).
- Użyj `--screen <index>`, aby wybrać ekran, gdy dostępnych jest wiele wyświetlaczy.

## Lokalizacja (węzły)

Węzły udostępniają `location.get`, gdy Lokalizacja jest włączona w ustawieniach.

Pomocnik CLI:

```bash
openclaw nodes location get --node <idOrNameOrIp>
openclaw nodes location get --node <idOrNameOrIp> --accuracy precise --max-age 15000 --location-timeout 10000
```

Uwagi:

- Lokalizacja jest **domyślnie wyłączona**.
- Tryb „Zawsze” wymaga uprawnień systemowych; pobieranie w tle jest best-effort.
- Odpowiedź zawiera lat/lon, dokładność (metry) oraz znacznik czasu.

## SMS (węzły Android)

Węzły Android mogą udostępniać `sms.send`, gdy użytkownik przyzna uprawnienie **SMS**, a urządzenie obsługuje telefonię.

Wywołanie niskopoziomowe:

```bash
openclaw nodes invoke --node <idOrNameOrIp> --command sms.send --params '{"to":"+15555550123","message":"Hello from OpenClaw"}'
```

Uwagi:

- Monit o uprawnienia musi zostać zaakceptowany na urządzeniu Android, zanim możliwości zostaną ogłoszone.
- Urządzenia tylko z Wi‑Fi, bez telefonii, nie będą ogłaszać `sms.send`.

## Polecenia systemowe (host węzła / węzeł mac)

Węzeł macOS udostępnia `system.run`, `system.notify` oraz `system.execApprovals.get/set`.
Headless host węzła udostępnia `system.run`, `system.which` oraz `system.execApprovals.get/set`.

Przykłady:

```bash
openclaw nodes run --node <idOrNameOrIp> -- echo "Hello from mac node"
openclaw nodes notify --node <idOrNameOrIp> --title "Ping" --body "Gateway ready"
```

Uwagi:

- `system.run` zwraca stdout/stderr/kod wyjścia w ładunku.
- `system.notify` respektuje stan uprawnień powiadomień w aplikacji macOS.
- `system.run` obsługuje `--cwd`, `--env KEY=VAL`, `--command-timeout` oraz `--needs-screen-recording`.
- `system.notify` obsługuje `--priority <passive|active|timeSensitive>` i `--delivery <system|overlay|auto>`.
- Węzły macOS odrzucają nadpisania `PATH`; headless hosty węzłów akceptują `PATH` tylko wtedy, gdy poprzedza on PATH hosta węzła.
- W trybie węzła macOS, `system.run` jest objęte zatwierdzeniami exec w aplikacji macOS (Ustawienia → Zatwierdzenia exec).
  Tryby ask/allowlist/full zachowują się tak samo jak w headless hoście węzła; odrzucone monity zwracają `SYSTEM_RUN_DENIED`.
- W headless hoście węzła, `system.run` jest objęte zatwierdzeniami exec (`~/.openclaw/exec-approvals.json`).

## Wiązanie exec z węzłem

Gdy dostępnych jest wiele węzłów, możesz powiązać exec z konkretnym węzłem.
Ustawia to domyślny węzeł dla `exec host=node` (i może być nadpisane per agent).

Domyślne globalne:

```bash
openclaw config set tools.exec.node "node-id-or-name"
```

Nadpisanie per agent:

```bash
openclaw config get agents.list
openclaw config set agents.list[0].tools.exec.node "node-id-or-name"
```

Wyczyść, aby zezwolić na dowolny węzeł:

```bash
openclaw config unset tools.exec.node
openclaw config unset agents.list[0].tools.exec.node
```

## Mapa uprawnień

Węzły mogą zawierać mapę `permissions` w `node.list` / `node.describe`, indeksowaną nazwą uprawnienia (np. `screenRecording`, `accessibility`) z wartościami logicznymi (`true` = przyznane).

## Headless host węzła (wieloplatformowy)

OpenClaw może uruchomić **headless host węzła** (bez UI), który łączy się z WebSocketem
Gateway i udostępnia `system.run` / `system.which`. Jest to przydatne na Linux/Windows
lub do uruchamiania minimalnego węzła obok serwera.

Uruchomienie:

```bash
openclaw node run --host <gateway-host> --port 18789
```

Uwagi:

- Parowanie jest nadal wymagane (Gateway wyświetli monit o zatwierdzenie węzła).
- Host węzła przechowuje swój identyfikator węzła, token, nazwę wyświetlaną oraz informacje o połączeniu z gatewayem w `~/.openclaw/node.json`.
- Zatwierdzenia exec są egzekwowane lokalnie przez `~/.openclaw/exec-approvals.json`
  (zob. [Exec approvals](/tools/exec-approvals)).
- Na macOS headless host węzła preferuje host exec aplikacji towarzyszącej, gdy jest osiągalny, i
  przechodzi na wykonanie lokalne, jeśli aplikacja jest niedostępna. Ustaw `OPENCLAW_NODE_EXEC_HOST=app`, aby wymagać
  aplikacji, lub `OPENCLAW_NODE_EXEC_FALLBACK=0`, aby wyłączyć fallback.
- Dodaj `--tls` / `--tls-fingerprint`, gdy Gateway WS używa TLS.

## Tryb węzła mac

- Aplikacja macOS w pasku menu łączy się z serwerem WS Gateway jako węzeł (dzięki czemu `openclaw nodes …` działa na tym Macu).
- W trybie zdalnym aplikacja otwiera tunel SSH dla portu Gateway i łączy się z `localhost`.
