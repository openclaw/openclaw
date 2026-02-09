---
summary: "Narzędzia debugowania: tryb watch, surowe strumienie modelu i śledzenie wycieków rozumowania"
read_when:
  - Musisz sprawdzić surowe wyjście modelu pod kątem wycieków rozumowania
  - Chcesz uruchomić Gateway w trybie watch podczas iteracji
  - Potrzebujesz powtarzalnego procesu debugowania
title: "Debugowanie"
---

# Debugowanie

Ta strona opisuje narzędzia pomocnicze do debugowania strumieniowego wyjścia, zwłaszcza gdy
dostawca miesza rozumowanie z normalnym tekstem.

## Nadpisania debugowania w czasie działania

Użyj `/debug` na czacie, aby ustawić **nadpisania konfiguracji tylko w czasie działania** (pamięć, nie dysk).
`/debug` jest domyślnie wyłączone; włącz je za pomocą `commands.debug: true`.
Jest to przydatne, gdy musisz przełączyć mało oczywiste ustawienia bez edytowania `openclaw.json`.

Przykłady:

```
/debug show
/debug set messages.responsePrefix="[openclaw]"
/debug unset messages.responsePrefix
/debug reset
```

`/debug reset` czyści wszystkie nadpisania i przywraca konfigurację zapisaną na dysku.

## Tryb watch Gateway

Do szybkiej iteracji uruchom gateway pod nadzorem obserwatora plików:

```bash
pnpm gateway:watch --force
```

Mapuje się to na:

```bash
tsx watch src/entry.ts gateway --force
```

Dodaj dowolne flagi CLI gateway po `gateway:watch`, a zostaną one przekazane
przy każdym restarcie.

## Profil dev + gateway dev (--dev)

Użyj profilu dev, aby odizolować stan i uruchomić bezpieczne, jednorazowe środowisko
do debugowania. Istnieją **dwie** flagi `--dev`:

- **Globalna `--dev` (profil):** izoluje stan w `~/.openclaw-dev` i
  domyślnie ustawia port gateway na `19001` (porty pochodne przesuwają się wraz z nim).
- **`gateway --dev`: informuje Gateway, aby automatycznie utworzyć domyślną konfigurację +
  obszar roboczy**, gdy ich brakuje (i pominąć BOOTSTRAP.md).

Zalecany przebieg (profil dev + bootstrap dev):

```bash
pnpm gateway:dev
OPENCLAW_PROFILE=dev openclaw tui
```

Jeśli nie masz jeszcze instalacji globalnej, uruchom CLI przez `pnpm openclaw ...`.

Co to robi:

1. **Izolacja profilu** (globalne `--dev`)
   - `OPENCLAW_PROFILE=dev`
   - `OPENCLAW_STATE_DIR=~/.openclaw-dev`
   - `OPENCLAW_CONFIG_PATH=~/.openclaw-dev/openclaw.json`
   - `OPENCLAW_GATEWAY_PORT=19001` (przeglądarka/canvas przesuwają się odpowiednio)

2. **Bootstrap dev** (`gateway --dev`)
   - Zapisuje minimalną konfigurację, jeśli jej brakuje (`gateway.mode=local`, powiązanie z loopback).
   - Ustawia `agent.workspace` na obszar roboczy dev.
   - Ustawia `agent.skipBootstrap=true` (bez BOOTSTRAP.md).
   - Zasiewa pliki obszaru roboczego, jeśli ich brakuje:
     `AGENTS.md`, `SOUL.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md`.
   - Domyślna tożsamość: **C3‑PO** (droid protokolarny).
   - Pomija dostawców kanałów w trybie dev (`OPENCLAW_SKIP_CHANNELS=1`).

Przebieg resetowania (świeży start):

```bash
pnpm gateway:dev:reset
```

Uwaga: `--dev` jest **globalną** flagą profilu i bywa przechwytywana przez niektóre narzędzia uruchomieniowe.
Jeśli musisz zapisać ją jawnie, użyj formy zmiennej środowiskowej:

```bash
OPENCLAW_PROFILE=dev openclaw gateway --dev --reset
```

`--reset` usuwa konfigurację, poświadczenia, sesje oraz obszar roboczy dev (używając
`trash`, a nie `rm`), a następnie odtwarza domyślną konfigurację dev.

Wskazówka: jeśli niedeweloperski gateway jest już uruchomiony (launchd/systemd), najpierw go zatrzymaj:

```bash
openclaw gateway stop
```

## Logowanie surowego strumienia (OpenClaw)

OpenClaw może rejestrować **surowy strumień asystenta** przed jakimkolwiek filtrowaniem/formatowaniem.
To najlepszy sposób, aby sprawdzić, czy rozumowanie dociera jako zwykłe delty tekstowe
(czy jako osobne bloki myślenia).

Włącz przez CLI:

```bash
pnpm gateway:watch --force --raw-stream
```

Opcjonalne nadpisanie ścieżki:

```bash
pnpm gateway:watch --force --raw-stream --raw-stream-path ~/.openclaw/logs/raw-stream.jsonl
```

Równoważny env vars:

```bash
OPENCLAW_RAW_STREAM=1
OPENCLAW_RAW_STREAM_PATH=~/.openclaw/logs/raw-stream.jsonl
```

Plik domyślny:

`~/.openclaw/logs/raw-stream.jsonl`

## Logowanie surowych fragmentów (pi-mono)

Aby przechwycić **surowe fragmenty zgodne z OpenAI** zanim zostaną sparsowane do bloków,
pi-mono udostępnia osobny logger:

```bash
PI_RAW_STREAM=1
```

Opcjonalna ścieżka:

```bash
PI_RAW_STREAM_PATH=~/.pi-mono/logs/raw-openai-completions.jsonl
```

Plik domyślny:

`~/.pi-mono/logs/raw-openai-completions.jsonl`

> Uwaga: jest to emitowane tylko przez procesy korzystające z dostawcy
> `openai-completions` w pi-mono.

## Uwagi dotyczące bezpieczeństwa

- Surowe logi strumieni mogą zawierać pełne prompty, wyjście narzędzi oraz dane użytkowników.
- Przechowuj logi lokalnie i usuwaj je po zakończeniu debugowania.
- Jeśli udostępniasz logi, najpierw usuń sekrety i dane osobowe (PII).
