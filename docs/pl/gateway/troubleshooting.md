---
summary: "Szczegółowy runbook rozwiązywania problemów dla gateway, kanałów, automatyzacji, węzłów i przeglądarki"
read_when:
  - Centrum rozwiązywania problemów skierowało Cię tutaj w celu pogłębionej diagnozy
  - Potrzebujesz stabilnych sekcji runbooka opartych na objawach z dokładnymi poleceniami
title: "Rozwiązywanie problemów"
---

# Rozwiązywanie problemów z Gateway

Ta strona to szczegółowy runbook.
Zacznij od [/help/troubleshooting](/help/troubleshooting), jeśli najpierw chcesz przejść szybki proces triażu.

## Drabina poleceń

Uruchom najpierw te polecenia, w tej kolejności:

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

Oczekiwane sygnały prawidłowego działania:

- `openclaw gateway status` pokazuje `Runtime: running` oraz `RPC probe: ok`.
- `openclaw doctor` nie zgłasza blokujących problemów konfiguracji/usług.
- `openclaw channels status --probe` pokazuje podłączone/gotowe kanały.

## Brak odpowiedzi

Jeśli kanały działają, ale nic nie odpowiada, sprawdź routing i politykę przed ponownym łączeniem czegokolwiek.

```bash
openclaw status
openclaw channels status --probe
openclaw pairing list <channel>
openclaw config get channels
openclaw logs --follow
```

Szukaj:

- Oczekujące parowanie dla nadawców DM-ów.
- Bramy wzmiankowania w grupach (`requireMention`, `mentionPatterns`).
- Niezgodności listy dozwolonych kanałów/grup.

Typowe sygnatury:

- `drop guild message (mention required` → wiadomość grupowa ignorowana do czasu wzmianki.
- `pairing request` → nadawca wymaga zatwierdzenia.
- `blocked` / `allowlist` → nadawca/kanał został odfiltrowany przez politykę.

Powiązane:

- [/channels/troubleshooting](/channels/troubleshooting)
- [/channels/pairing](/channels/pairing)
- [/channels/groups](/channels/groups)

## Łączność interfejsu sterowania dashboardu

Gdy dashboard/interfejs sterowania nie łączy się, zweryfikuj adres URL, tryb uwierzytelniania oraz założenia dotyczące bezpiecznego kontekstu.

```bash
openclaw gateway status
openclaw status
openclaw logs --follow
openclaw doctor
openclaw gateway status --json
```

Szukaj:

- Prawidłowy adres URL sondy i adres URL dashboardu.
- Niezgodność trybu/tokena uwierzytelniania między klientem a gateway.
- Użycie HTTP tam, gdzie wymagana jest tożsamość urządzenia.

Typowe sygnatury:

- `device identity required` → niezabezpieczony kontekst lub brak uwierzytelniania urządzenia.
- `unauthorized` / pętla ponownych połączeń → niezgodność tokena/hasła.
- `gateway connect failed:` → błędny host/port/docelowy URL.

Powiązane:

- [/web/control-ui](/web/control-ui)
- [/gateway/authentication](/gateway/authentication)
- [/gateway/remote](/gateway/remote)

## Usługa Gateway nie działa

Użyj tego, gdy usługa jest zainstalowana, ale proces nie pozostaje uruchomiony.

```bash
openclaw gateway status
openclaw status
openclaw logs --follow
openclaw doctor
openclaw gateway status --deep
```

Szukaj:

- `Runtime: stopped` ze wskazówkami wyjścia.
- Niezgodność konfiguracji usługi (`Config (cli)` vs `Config (service)`).
- Konflikty portów/nasłuchiwania.

Typowe sygnatury:

- `Gateway start blocked: set gateway.mode=local` → lokalny tryb gateway nie jest włączony.
- `refusing to bind gateway ... without auth` → bindowanie poza loopback bez tokena/hasła.
- `another gateway instance is already listening` / `EADDRINUSE` → konflikt portów.

Powiązane:

- [/gateway/background-process](/gateway/background-process)
- [/gateway/configuration](/gateway/configuration)
- [/gateway/doctor](/gateway/doctor)

## Kanał podłączony, ale wiadomości nie przepływają

Jeśli stan kanału to „połączony”, ale przepływ wiadomości nie działa, skup się na polityce, uprawnieniach oraz regułach dostarczania specyficznych dla kanału.

```bash
openclaw channels status --probe
openclaw pairing list <channel>
openclaw status --deep
openclaw logs --follow
openclaw config get channels
```

Szukaj:

- Politykę DM-ów (`pairing`, `allowlist`, `open`, `disabled`).
- Listę dozwolonych grup oraz wymagania dotyczące wzmianek.
- Brakujące uprawnienia/zakresy API kanału.

Typowe sygnatury:

- `mention required` → wiadomość zignorowana przez politykę wzmianek grupowych.
- `pairing` / ślady oczekującego zatwierdzenia → nadawca nie jest zatwierdzony.
- `missing_scope`, `not_in_channel`, `Forbidden`, `401/403` → problem z uwierzytelnianiem/uprawnieniami kanału.

Powiązane:

- [/channels/troubleshooting](/channels/troubleshooting)
- [/channels/whatsapp](/channels/whatsapp)
- [/channels/telegram](/channels/telegram)
- [/channels/discord](/channels/discord)

## Dostarczanie cron i heartbeat

Jeśli cron lub heartbeat nie uruchomiły się lub nie dostarczyły danych, najpierw zweryfikuj stan planisty, a następnie cel dostarczania.

```bash
openclaw cron status
openclaw cron list
openclaw cron runs --id <jobId> --limit 20
openclaw system heartbeat last
openclaw logs --follow
```

Szukaj:

- Włączony cron i obecność następnego wybudzenia.
- Stan historii uruchomień zadań (`ok`, `skipped`, `error`).
- Powody pominięcia heartbeat (`quiet-hours`, `requests-in-flight`, `alerts-disabled`).

Typowe sygnatury:

- `cron: scheduler disabled; jobs will not run automatically` → cron wyłączony.
- `cron: timer tick failed` → błąd tyknięcia planisty; sprawdź pliki/logi/błędy środowiska uruchomieniowego.
- `heartbeat skipped` z `reason=quiet-hours` → poza oknem aktywnych godzin.
- `heartbeat: unknown accountId` → nieprawidłowy identyfikator konta dla celu dostarczania heartbeat.

Powiązane:

- [/automation/troubleshooting](/automation/troubleshooting)
- [/automation/cron-jobs](/automation/cron-jobs)
- [/gateway/heartbeat](/gateway/heartbeat)

## Sparowany węzeł — narzędzie nie działa

Jeśli węzeł jest sparowany, ale narzędzia nie działają, wyizoluj stan pierwszoplanowy, uprawnienia i zatwierdzenia.

```bash
openclaw nodes status
openclaw nodes describe --node <idOrNameOrIp>
openclaw approvals get --node <idOrNameOrIp>
openclaw logs --follow
openclaw status
```

Szukaj:

- Węzeł online z oczekiwanymi możliwościami.
- Nadania uprawnień systemu operacyjnego dla kamery/mikrofonu/lokalizacji/ekranu.
- Zatwierdzanie wykonania (exec) oraz stan listy dozwolonych.

Typowe sygnatury:

- `NODE_BACKGROUND_UNAVAILABLE` → aplikacja węzła musi być na pierwszym planie.
- `*_PERMISSION_REQUIRED` / `LOCATION_PERMISSION_REQUIRED` → brakujące uprawnienie systemu operacyjnego.
- `SYSTEM_RUN_DENIED: approval required` → oczekujące zatwierdzenie wykonania.
- `SYSTEM_RUN_DENIED: allowlist miss` → polecenie zablokowane przez listę dozwolonych.

Powiązane:

- [/nodes/troubleshooting](/nodes/troubleshooting)
- [/nodes/index](/nodes/index)
- [/tools/exec-approvals](/tools/exec-approvals)

## Narzędzie przeglądarki nie działa

Użyj tego, gdy akcje narzędzia przeglądarki zawodzą, mimo że sam gateway jest sprawny.

```bash
openclaw browser status
openclaw browser start --browser-profile openclaw
openclaw browser profiles
openclaw logs --follow
openclaw doctor
```

Szukaj:

- Prawidłową ścieżkę do pliku wykonywalnego przeglądarki.
- Osiągalność profilu CDP.
- Dołączenie karty przekaźnika rozszerzenia dla `profile="chrome"`.

Typowe sygnatury:

- `Failed to start Chrome CDP on port` → proces przeglądarki nie uruchomił się.
- `browser.executablePath not found` → skonfigurowana ścieżka jest nieprawidłowa.
- `Chrome extension relay is running, but no tab is connected` → przekaźnik rozszerzenia nie został dołączony.
- `Browser attachOnly is enabled ... not reachable` → profil „attach-only” nie ma osiągalnego celu.

Powiązane:

- [/tools/browser-linux-troubleshooting](/tools/browser-linux-troubleshooting)
- [/tools/chrome-extension](/tools/chrome-extension)
- [/tools/browser](/tools/browser)

## Jeśli po aktualizacji coś nagle przestało działać

Większość problemów po aktualizacji to dryf konfiguracji lub egzekwowanie teraz bardziej rygorystycznych ustawień domyślnych.

### 1. Zmieniło się zachowanie uwierzytelniania i nadpisywania URL

```bash
openclaw gateway status
openclaw config get gateway.mode
openclaw config get gateway.remote.url
openclaw config get gateway.auth.mode
```

Co sprawdzić:

- Jeśli `gateway.mode=remote`, wywołania CLI mogą trafiać do zdalnego celu, podczas gdy lokalna usługa działa poprawnie.
- Jawne wywołania `--url` nie wracają do zapisanych poświadczeń.

Typowe sygnatury:

- `gateway connect failed:` → błędny docelowy URL.
- `unauthorized` → punkt końcowy osiągalny, ale niewłaściwe uwierzytelnianie.

### 2. Bardziej rygorystyczne ograniczenia bindowania i uwierzytelniania

```bash
openclaw config get gateway.bind
openclaw config get gateway.auth.token
openclaw gateway status
openclaw logs --follow
```

Co sprawdzić:

- Bindowania poza loopback (`lan`, `tailnet`, `custom`) wymagają skonfigurowanego uwierzytelniania.
- Stare klucze, takie jak `gateway.token`, nie zastępują `gateway.auth.token`.

Typowe sygnatury:

- `refusing to bind gateway ... without auth` → niezgodność bindowania i uwierzytelniania.
- `RPC probe: failed` przy działającym runtime → gateway żyje, ale jest niedostępny z bieżącym uwierzytelnianiem/URL.

### 3. Zmienił się stan parowania i tożsamości urządzeń

```bash
openclaw devices list
openclaw pairing list <channel>
openclaw logs --follow
openclaw doctor
```

Co sprawdzić:

- Oczekujące zatwierdzenia urządzeń dla dashboardu/węzłów.
- Oczekujące zatwierdzenia parowania DM-ów po zmianach polityki lub tożsamości.

Typowe sygnatury:

- `device identity required` → niespełnione uwierzytelnianie urządzenia.
- `pairing required` → nadawca/urządzenie musi zostać zatwierdzone.

Jeśli po sprawdzeniach konfiguracja usługi i runtime nadal się nie zgadzają, zainstaluj ponownie metadane usługi z tego samego katalogu profilu/stanu:

```bash
openclaw gateway install --force
openclaw gateway restart
```

Powiązane:

- [/gateway/pairing](/gateway/pairing)
- [/gateway/authentication](/gateway/authentication)
- [/gateway/background-process](/gateway/background-process)
