---
summary: "Uruchom most ACP dla integracji z IDE"
read_when:
  - Konfigurowanie integracji IDE opartych na ACP
  - Debugowanie routingu sesji ACP do Gateway
title: "acp"
---

# acp

Uruchamia most ACP (Agent Client Protocol), który komunikuje się z Gateway OpenClaw.

To polecenie mówi ACP przez stdio dla IDE i przekazuje prompty do Gateway
przez WebSocket. Utrzymuje mapowanie sesji ACP na klucze sesji Gateway.

## Użycie

```bash
openclaw acp

# Remote Gateway
openclaw acp --url wss://gateway-host:18789 --token <token>

# Attach to an existing session key
openclaw acp --session agent:main:main

# Attach by label (must already exist)
openclaw acp --session-label "support inbox"

# Reset the session key before the first prompt
openclaw acp --session agent:main:main --reset-session
```

## Klient ACP (debug)

Użyj wbudowanego klienta ACP, aby sprawdzić poprawność działania mostu bez IDE.
Uruchamia on most ACP i pozwala interaktywnie wpisywać prompty.

```bash
openclaw acp client

# Point the spawned bridge at a remote Gateway
openclaw acp client --server-args --url wss://gateway-host:18789 --token <token>

# Override the server command (default: openclaw)
openclaw acp client --server "node" --server-args openclaw.mjs acp --url ws://127.0.0.1:19001
```

## Jak tego używać

Użyj ACP, gdy IDE (lub inny klient) mówi Agent Client Protocol i chcesz,
aby sterował sesją Gateway OpenClaw.

1. Upewnij się, że Gateway działa (lokalnie lub zdalnie).
2. Skonfiguruj cel Gateway (konfiguracja lub flagi).
3. Skieruj IDE do uruchamiania `openclaw acp` przez stdio.

Przykładowa konfiguracja (utrwalona):

```bash
openclaw config set gateway.remote.url wss://gateway-host:18789
openclaw config set gateway.remote.token <token>
```

Przykładowe uruchomienie bezpośrednie (bez zapisu konfiguracji):

```bash
openclaw acp --url wss://gateway-host:18789 --token <token>
```

## Wybór agentów

ACP nie wybiera agentów bezpośrednio. Trasuje według klucza sesji Gateway.

Użyj kluczy sesji o zakresie agenta, aby wskazać konkretnego agenta:

```bash
openclaw acp --session agent:main:main
openclaw acp --session agent:design:main
openclaw acp --session agent:qa:bug-123
```

Każda sesja ACP mapuje się na pojedynczy klucz sesji Gateway. Jeden agent może mieć wiele
sesji; ACP domyślnie używa izolowanej sesji `acp:<uuid>`, chyba że nadpiszesz
klucz lub etykietę.

## Konfiguracja edytora Zed

Dodaj niestandardowego agenta ACP w `~/.config/zed/settings.json` (lub użyj interfejsu Ustawień Zed):

```json
{
  "agent_servers": {
    "OpenClaw ACP": {
      "type": "custom",
      "command": "openclaw",
      "args": ["acp"],
      "env": {}
    }
  }
}
```

Aby wskazać konkretny Gateway lub agenta:

```json
{
  "agent_servers": {
    "OpenClaw ACP": {
      "type": "custom",
      "command": "openclaw",
      "args": [
        "acp",
        "--url",
        "wss://gateway-host:18789",
        "--token",
        "<token>",
        "--session",
        "agent:design:main"
      ],
      "env": {}
    }
  }
}
```

W Zed otwórz panel Agent i wybierz „OpenClaw ACP”, aby rozpocząć wątek.

## Mapowanie sesji

Domyślnie sesje ACP otrzymują izolowany klucz sesji Gateway z prefiksem `acp:`.
Aby ponownie użyć znanej sesji, przekaż klucz sesji lub etykietę:

- `--session <key>`: użyj konkretnego klucza sesji Gateway.
- `--session-label <label>`: rozwiąż istniejącą sesję według etykiety.
- `--reset-session`: wygeneruj nowy identyfikator sesji dla tego klucza (ten sam klucz, nowy zapis).

Jeśli klient ACP obsługuje metadane, możesz nadpisać ustawienia per sesja:

```json
{
  "_meta": {
    "sessionKey": "agent:main:main",
    "sessionLabel": "support inbox",
    "resetSession": true
  }
}
```

Dowiedz się więcej o kluczach sesji na [/concepts/session](/concepts/session).

## Opcje

- `--url <url>`: URL WebSocket Gateway (domyślnie gateway.remote.url, gdy skonfigurowano).
- `--token <token>`: token uwierzytelniania Gateway.
- `--password <password>`: hasło uwierzytelniania Gateway.
- `--session <key>`: domyślny klucz sesji.
- `--session-label <label>`: domyślna etykieta sesji do rozwiązania.
- `--require-existing`: zakończ niepowodzeniem, jeśli klucz/etykieta sesji nie istnieje.
- `--reset-session`: zresetuj klucz sesji przed pierwszym użyciem.
- `--no-prefix-cwd`: nie poprzedzaj promptów katalogiem roboczym.
- `--verbose, -v`: szczegółowe logowanie do stderr.

### Opcje `acp client`

- `--cwd <dir>`: katalog roboczy dla sesji ACP.
- `--server <command>`: polecenie serwera ACP (domyślnie: `openclaw`).
- `--server-args <args...>`: dodatkowe argumenty przekazywane do serwera ACP.
- `--server-verbose`: włącz szczegółowe logowanie na serwerze ACP.
- `--verbose, -v`: szczegółowe logowanie klienta.
