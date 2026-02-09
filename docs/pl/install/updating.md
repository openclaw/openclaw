---
summary: "Bezpieczna aktualizacja OpenClaw (instalacja globalna lub ze źródeł) oraz strategia wycofywania"
read_when:
  - Aktualizacja OpenClaw
  - Coś się psuje po aktualizacji
title: "Aktualizacja"
---

# Aktualizacja

OpenClaw rozwija się szybko (przed „1.0”). Traktuj aktualizacje jak wdrażanie infrastruktury: aktualizacja → uruchomienie kontroli → restart (lub użycie `openclaw update`, który wykonuje restart) → weryfikacja.

## Zalecane: ponowne uruchomienie instalatora ze strony (aktualizacja w miejscu)

**Preferowaną** ścieżką aktualizacji jest ponowne uruchomienie instalatora ze strony internetowej. Wykrywa on istniejące instalacje, aktualizuje je w miejscu i uruchamia `openclaw doctor` w razie potrzeby.

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

Uwagi:

- Dodaj `--no-onboard`, jeśli nie chcesz, aby kreator onboardingu uruchomił się ponownie.

- Dla **instalacji ze źródeł** użyj:

  ```bash
  curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git --no-onboard
  ```

  Instalator wykona `git pull --rebase` **tylko** wtedy, gdy repozytorium jest czyste.

- Dla **instalacji globalnych** skrypt pod spodem używa `npm install -g openclaw@latest`.

- starszych wersji: `clawdbot` pozostaje dostępne jako warstwa kompatybilności.

## Zanim zaktualizujesz

- Wiedz, jak instalowałeś: **globalnie** (npm/pnpm) czy **ze źródeł** (git clone).
- Wiedz, jak działa Twój Gateway: **terminal na pierwszym planie** czy **usługa nadzorowana** (launchd/systemd).
- Zrób zrzut krawędzi:
  - Konfiguracja: `~/.openclaw/openclaw.json`
  - Poświadczenia: `~/.openclaw/credentials/`
  - Obszar roboczy: `~/.openclaw/workspace`

## Aktualizacja (instalacja globalna)

Instalacja globalna (wybierz jedną):

```bash
npm i -g openclaw@latest
```

```bash
pnpm add -g openclaw@latest
```

**Nie** zalecamy Bun jako środowiska uruchomieniowego Gateway (błędy WhatsApp/Telegram).

Aby przełączyć kanały aktualizacji (instalacje git + npm):

```bash
openclaw update --channel beta
openclaw update --channel dev
openclaw update --channel stable
```

Użyj `--tag <dist-tag|version>` dla jednorazowego tagu/wersji instalacji.

Zobacz [Kanały rozwojowe](/install/development-channels), aby poznać semantykę kanałów i informacje o wydaniach.

Uwaga: w instalacjach npm gateway przy starcie zapisuje wskazówkę o aktualizacji (sprawdza bieżący tag kanału). Wyłącz przez `update.checkOnStart: false`.

Następnie:

```bash
openclaw doctor
openclaw gateway restart
openclaw health
```

Uwagi:

- Jeśli Gateway działa jako usługa, `openclaw gateway restart` jest preferowane zamiast zabijania PID-ów.
- Jeśli jesteś przypięty do konkretnej wersji, zobacz „Wycofywanie / przypinanie” poniżej.

## Aktualizacja (`openclaw update`)

Dla **instalacji ze źródeł** (git checkout) preferuj:

```bash
openclaw update
```

Uruchamia to „w miarę bezpieczny” przepływ aktualizacji:

- Wymaga czystego drzewa roboczego.
- Przełącza na wybrany kanał (tag lub gałąź).
- Pobiera zmiany i wykonuje rebase względem skonfigurowanego upstreamu (kanał dev).
- Instaluje zależności, buduje, buduje Control UI i uruchamia `openclaw doctor`.
- Domyślnie restartuje gateway (użyj `--no-restart`, aby pominąć).

Jeśli instalowałeś przez **npm/pnpm** (bez metadanych git), `openclaw update` spróbuje zaktualizować przez menedżera pakietów. Jeśli nie wykryje instalacji, użyj zamiast tego „Aktualizacja (instalacja globalna)”.

## Aktualizacja (Control UI / RPC)

Control UI ma opcję **Update & Restart** (RPC: `update.run`). Działa ona następująco:

1. Uruchamia ten sam przepływ aktualizacji ze źródeł co `openclaw update` (tylko git checkout).
2. Zapisuje znacznik restartu ze strukturalnym raportem (ogon stdout/stderr).
3. Restartuje gateway i wysyła raport do ostatniej aktywnej sesji.

Jeśli rebase się nie powiedzie, gateway przerywa i restartuje się bez zastosowania aktualizacji.

## Aktualizacja (ze źródeł)

Z checkoutu repozytorium:

Preferowane:

```bash
openclaw update
```

Ręcznie (w przybliżeniu równoważne):

```bash
git pull
pnpm install
pnpm build
pnpm ui:build # auto-installs UI deps on first run
openclaw doctor
openclaw health
```

Uwagi:

- `pnpm build` ma znaczenie, gdy uruchamiasz spakowany plik binarny `openclaw` ([`openclaw.mjs`](https://github.com/openclaw/openclaw/blob/main/openclaw.mjs)) lub używasz Node do uruchomienia `dist/`.
- Jeśli uruchamiasz z checkoutu repozytorium bez instalacji globalnej, używaj `pnpm openclaw ...` do poleceń CLI.
- Jeśli uruchamiasz bezpośrednio z TypeScript (`pnpm openclaw ...`), przebudowa zwykle nie jest konieczna, ale **migracje konfiguracji nadal obowiązują** → uruchom doctor.
- Przełączanie między instalacjami globalnymi i git jest łatwe: zainstaluj drugi wariant, a następnie uruchom `openclaw doctor`, aby wpis usługi gateway został przepisany na bieżącą instalację.

## Zawsze uruchamiaj: `openclaw doctor`

Doctor to polecenie „bezpiecznej aktualizacji”. Jest celowo proste: naprawa + migracja + ostrzeżenia.

Uwaga: jeśli korzystasz z **instalacji ze źródeł** (git checkout), `openclaw doctor` zaproponuje najpierw uruchomienie `openclaw update`.

Typowe działania:

- Migracja przestarzałych kluczy konfiguracji / starszych lokalizacji plików konfiguracyjnych.
- Audyt polityk DM i ostrzeżenia o ryzykownych „otwartych” ustawieniach.
- Sprawdzenie kondycji Gateway i możliwość zaproponowania restartu.
- Wykrywanie i migracja starszych usług gateway (launchd/systemd; legacy schtasks) do bieżących usług OpenClaw.
- Na Linuksie: zapewnienie włączonego lingeringu użytkownika systemd (aby Gateway przetrwał wylogowanie).

Szczegóły: [Doctor](/gateway/doctor)

## Uruchamianie / zatrzymywanie / restart Gateway

CLI (działa niezależnie od systemu):

```bash
openclaw gateway status
openclaw gateway stop
openclaw gateway restart
openclaw gateway --port 18789
openclaw logs --follow
```

Jeśli masz nadzór usług:

- macOS launchd (LaunchAgent dołączony do aplikacji): `launchctl kickstart -k gui/$UID/bot.molt.gateway` (użyj `bot.molt.<profile>`; starsze `com.openclaw.*` nadal działa)
- Linux systemd (usługa użytkownika): `systemctl --user restart openclaw-gateway[-<profile>].service`
- Windows (WSL2): `systemctl --user restart openclaw-gateway[-<profile>].service`
  - `launchctl`/`systemctl` działają tylko, jeśli usługa jest zainstalowana; w przeciwnym razie uruchom `openclaw gateway install`.

Runbook + dokładne etykiety usług: [Gateway runbook](/gateway)

## Wycofywanie / przypinanie (gdy coś się psuje)

### Przypinanie (instalacja globalna)

Zainstaluj znaną, działającą wersję (zastąp `<version>` ostatnią działającą):

```bash
npm i -g openclaw@<version>
```

```bash
pnpm add -g openclaw@<version>
```

Wskazówka: aby zobaczyć aktualnie opublikowaną wersję, uruchom `npm view openclaw version`.

Następnie restart + ponowne uruchomienie doctor:

```bash
openclaw doctor
openclaw gateway restart
```

### Przypinanie (ze źródeł) według daty

Wybierz commit z danej daty (przykład: „stan main na dzień 2026-01-01”):

```bash
git fetch origin
git checkout "$(git rev-list -n 1 --before=\"2026-01-01\" origin/main)"
```

Następnie ponownie zainstaluj zależności + restart:

```bash
pnpm install
pnpm build
openclaw gateway restart
```

Jeśli później chcesz wrócić do najnowszej wersji:

```bash
git checkout main
git pull
```

## Jeśli utknąłeś

- Uruchom ponownie `openclaw doctor` i uważnie przeczytaj wyjście (często podaje rozwiązanie).
- Sprawdź: [Rozwiązywanie problemów](/gateway/troubleshooting)
- Zapytaj na Discordzie: [https://discord.gg/clawd](https://discord.gg/clawd)
