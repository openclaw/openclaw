---
summary: "Środowisko uruchomieniowe Gateway na macOS (zewnętrzna usługa launchd)"
read_when:
  - Pakietowanie OpenClaw.app
  - Debugowanie usługi launchd Gateway na macOS
  - Instalowanie CLI Gateway dla macOS
title: "Gateway na macOS"
---

# Gateway na macOS (zewnętrzny launchd)

OpenClaw.app nie dołącza już Node/Bun ani środowiska uruchomieniowego Gateway. Aplikacja macOS
oczekuje **zewnętrznej** instalacji CLI `openclaw`, nie uruchamia Gateway jako
procesu potomnego i zarządza usługą launchd na poziomie użytkownika, aby utrzymać Gateway
w działaniu (lub dołącza do istniejącego lokalnego Gateway, jeśli jest już uruchomiony).

## Zainstaluj CLI (wymagane dla trybu lokalnego)

Na Macu potrzebujesz Node 22+, a następnie zainstaluj globalnie `openclaw`:

```bash
npm install -g openclaw@<version>
```

Przycisk **Install CLI** w aplikacji macOS uruchamia ten sam proces przez npm/pnpm (bun niezalecany dla środowiska uruchomieniowego Gateway).

## Launchd (Gateway jako LaunchAgent)

Etykieta:

- `bot.molt.gateway` (lub `bot.molt.<profile>`; starsza `com.openclaw.*` może pozostać)

Lokalizacja plist (na użytkownika):

- `~/Library/LaunchAgents/bot.molt.gateway.plist`
  (lub `~/Library/LaunchAgents/bot.molt.<profile>.plist`)

Menedżer:

- Aplikacja macOS zarządza instalacją/aktualizacją LaunchAgent w trybie lokalnym.
- CLI również może go zainstalować: `openclaw gateway install`.

Zachowanie:

- „OpenClaw Active” włącza/wyłącza LaunchAgent.
- Zamknięcie aplikacji **nie** zatrzymuje gateway (launchd utrzymuje go przy życiu).
- Jeśli Gateway jest już uruchomiony na skonfigurowanym porcie, aplikacja dołącza do
  niego zamiast uruchamiać nowy.

Logowanie:

- stdout/err launchd: `/tmp/openclaw/openclaw-gateway.log`

## Zgodność wersji

Aplikacja macOS sprawdza wersję gateway względem własnej wersji. Jeśli są
niezgodne, zaktualizuj globalne CLI, aby pasowało do wersji aplikacji.

## Kontrola dymu

```bash
openclaw --version

OPENCLAW_SKIP_CHANNELS=1 \
OPENCLAW_SKIP_CANVAS_HOST=1 \
openclaw gateway --port 18999 --bind loopback
```

Następnie:

```bash
openclaw gateway call health --url ws://127.0.0.1:18999 --timeout 3000
```
