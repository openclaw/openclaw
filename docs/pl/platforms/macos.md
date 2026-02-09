---
summary: "Aplikacja towarzysząca OpenClaw na macOS (pasek menu + broker gateway)"
read_when:
  - Implementowanie funkcji aplikacji macOS
  - Zmiany cyklu życia gateway lub mostkowania węzłów na macOS
title: "Aplikacja macOS"
---

# OpenClaw macOS Companion (pasek menu + broker gateway)

Aplikacja macOS jest **towarzyszem na pasku menu** dla OpenClaw. Zarządza uprawnieniami,
uruchamia lub dołącza lokalnie do Gateway (launchd lub ręcznie) oraz udostępnia
możliwości macOS agentowi jako węzeł.

## Co robi

- Wyświetla natywne powiadomienia i status na pasku menu.
- Zarządza monitami TCC (Powiadomienia, Dostępność, Nagrywanie ekranu, Mikrofon,
  Rozpoznawanie mowy, Automatyzacja/AppleScript).
- Uruchamia lub łączy się z Gateway (lokalnie lub zdalnie).
- Udostępnia narzędzia dostępne tylko na macOS (Canvas, Camera, Screen Recording, `system.run`).
- Uruchamia lokalną usługę hosta węzła w trybie **remote** (launchd) i zatrzymuje ją w trybie **local**.
- Opcjonalnie hostuje **PeekabooBridge** do automatyzacji UI.
- Na żądanie instaluje globalne CLI (`openclaw`) przez npm/pnpm (bun niezalecany dla środowiska uruchomieniowego Gateway).

## Tryb local vs remote

- **Local** (domyślny): aplikacja dołącza do działającego lokalnie Gateway, jeśli jest obecny;
  w przeciwnym razie włącza usługę launchd przez `openclaw gateway install`.
- **Remote**: aplikacja łączy się z Gateway przez SSH/Tailscale i nigdy nie uruchamia
  lokalnego procesu.
  Aplikacja uruchamia lokalną **usługę hosta węzła**, aby zdalny Gateway mógł dotrzeć do tego Maca.
  Aplikacja nie uruchamia Gateway jako procesu potomnego.

## Sterowanie launchd

Aplikacja zarządza per‑użytkownikowym LaunchAgent oznaczonym etykietą `bot.molt.gateway`
(lub `bot.molt.<profile>` przy użyciu `--profile`/`OPENCLAW_PROFILE`; starszy `com.openclaw.*` nadal się wyładowuje).

```bash
launchctl kickstart -k gui/$UID/bot.molt.gateway
launchctl bootout gui/$UID/bot.molt.gateway
```

Zastąp etykietę wartością `bot.molt.<profile>` podczas uruchamiania nazwanego profilu.

Jeśli LaunchAgent nie jest zainstalowany, włącz go z poziomu aplikacji lub uruchom
`openclaw gateway install`.

## Możliwości węzła (mac)

Aplikacja macOS przedstawia się jako węzeł. Typowe polecenia:

- Canvas: `canvas.present`, `canvas.navigate`, `canvas.eval`, `canvas.snapshot`, `canvas.a2ui.*`
- Camera: `camera.snap`, `camera.clip`
- Screen: `screen.record`
- System: `system.run`, `system.notify`

Węzeł raportuje mapę `permissions`, aby agenci mogli zdecydować, co jest dozwolone.

Usługa węzła + IPC aplikacji:

- Gdy bezgłowa usługa hosta węzła działa (tryb remote), łączy się z Gateway WS jako węzeł.
- `system.run` wykonuje się w aplikacji macOS (kontekst UI/TCC) przez lokalne gniazdo Unix; monity i wyjście pozostają w aplikacji.

Diagram (SCI):

```
Gateway -> Node Service (WS)
                 |  IPC (UDS + token + HMAC + TTL)
                 v
             Mac App (UI + TCC + system.run)
```

## Zatwierdzanie wykonania (system.run)

`system.run` jest kontrolowane przez **zatwierdzanie wykonania (Exec approvals)** w aplikacji macOS (Ustawienia → Exec approvals).
Bezpieczeństwo + pytania + lista dozwolonych są przechowywane lokalnie na Macu w:

```
~/.openclaw/exec-approvals.json
```

Przykład:

```json
{
  "version": 1,
  "defaults": {
    "security": "deny",
    "ask": "on-miss"
  },
  "agents": {
    "main": {
      "security": "allowlist",
      "ask": "on-miss",
      "allowlist": [{ "pattern": "/opt/homebrew/bin/rg" }]
    }
  }
}
```

Uwagi:

- Wpisy `allowlist` to wzorce glob dla rozwiązywanych ścieżek binarnych.
- Wybranie „Always Allow” w monicie dodaje to polecenie do listy dozwolonych.
- Nadpisania środowiska `system.run` są filtrowane (odrzuca `PATH`, `DYLD_*`, `LD_*`, `NODE_OPTIONS`, `PYTHON*`, `PERL*`, `RUBYOPT`), a następnie łączone ze środowiskiem aplikacji.

## Głębokie linki

Aplikacja rejestruje schemat URL `openclaw://` dla działań lokalnych.

### `openclaw://agent`

Wyzwala żądanie Gateway `agent`.

```bash
open 'openclaw://agent?message=Hello%20from%20deep%20link'
```

Parametry zapytania:

- `message` (wymagane)
- `sessionKey` (opcjonalne)
- `thinking` (opcjonalne)
- `deliver` / `to` / `channel` (opcjonalne)
- `timeoutSeconds` (opcjonalne)
- `key` (opcjonalny klucz trybu bezobsługowego)

Bezpieczeństwo:

- Bez `key` aplikacja prosi o potwierdzenie.
- Z prawidłowym `key` uruchomienie jest bezobsługowe (przeznaczone do osobistych automatyzacji).

## Przepływ onboardingu (typowy)

1. Zainstaluj i uruchom **OpenClaw.app**.
2. Ukończ listę kontrolną uprawnień (monity TCC).
3. Upewnij się, że aktywny jest tryb **Local** i Gateway działa.
4. Zainstaluj CLI, jeśli chcesz mieć dostęp z terminala.

## Build & dev workflow (natywny)

- `cd apps/macos && swift build`
- `swift run OpenClaw` (lub Xcode)
- Pakowanie aplikacji: `scripts/package-mac-app.sh`

## Debugowanie łączności gateway (macOS CLI)

Użyj debugowego CLI, aby przećwiczyć ten sam handshake WebSocket Gateway i logikę
wykrywania, której używa aplikacja macOS, bez uruchamiania aplikacji.

```bash
cd apps/macos
swift run openclaw-mac connect --json
swift run openclaw-mac discover --timeout 3000 --json
```

Opcje połączenia:

- `--url <ws://host:port>`: nadpisanie konfiguracji
- `--mode <local|remote>`: rozwiązywanie z konfiguracji (domyślnie: config lub local)
- `--probe`: wymuszenie świeżego sondowania stanu
- `--timeout <ms>`: limit czasu żądania (domyślnie: `15000`)
- `--json`: wyjście strukturalne do porównań

Opcje wykrywania:

- `--include-local`: uwzględnij gatewaye, które byłyby filtrowane jako „local”
- `--timeout <ms>`: całkowite okno wykrywania (domyślnie: `2000`)
- `--json`: wyjście strukturalne do porównań

Wskazówka: porównaj z `openclaw gateway discover --json`, aby sprawdzić, czy
potok wykrywania aplikacji macOS (NWBrowser + zapasowe DNS‑SD tailnet) różni się od
wykrywania opartego na `dns-sd` w Node CLI.

## Instalacja połączenia zdalnego (tunele SSH)

Gdy aplikacja macOS działa w trybie **Remote**, otwiera tunel SSH, aby lokalne
komponenty UI mogły komunikować się ze zdalnym Gateway tak, jakby był na localhost.

### Tunel sterujący (port WebSocket Gateway)

- **Cel:** testy zdrowia, status, Web Chat, konfiguracja i inne wywołania płaszczyzny sterowania.
- **Port lokalny:** port Gateway (domyślnie `18789`), zawsze stały.
- **Port zdalny:** ten sam port Gateway na hoście zdalnym.
- **Zachowanie:** brak losowego portu lokalnego; aplikacja ponownie używa istniejącego, zdrowego tunelu
  lub restartuje go w razie potrzeby.
- **Kształt SSH:** `ssh -N -L <local>:127.0.0.1:<remote>` z BatchMode +
  ExitOnForwardFailure + opcjami keepalive.
- **Raportowanie IP:** tunel SSH używa loopback, więc gateway zobaczy IP węzła jako
  `127.0.0.1`. Użyj transportu **Direct (ws/wss)**, jeśli chcesz, aby pojawiło się
  prawdziwe IP klienta (zobacz [macOS remote access](/platforms/mac/remote)).

Instrukcje konfiguracji: [macOS remote access](/platforms/mac/remote). Szczegóły
protokołu: [Gateway protocol](/gateway/protocol).

## Powiązana dokumentacja

- [Gateway runbook](/gateway)
- [Gateway (macOS)](/platforms/mac/bundled-gateway)
- [Uprawnienia macOS](/platforms/mac/permissions)
- [Canvas](/platforms/mac/canvas)
