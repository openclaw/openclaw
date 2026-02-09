---
summary: "Kör ACP-bryggan för IDE-integrationer"
read_when:
  - Konfigurera ACP-baserade IDE-integrationer
  - Felsökning av ACP-sessionsroutning till Gateway
title: "acp"
---

# acp

Kör ACP-bryggan (Agent Client Protocol) som kommunicerar med en OpenClaw Gateway.

Detta kommando talar AVS över stdio för IDEs och vidare uppmaningar till Gateway
över WebSocket. Det håller AVS-sessioner mappade till Gateway-sessionsnycklar.

## Användning

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

## ACP-klient (debug)

Använd den inbyggda AVS-klienten för att kontrollera bron utan IDE.
Det ger upphov till AVS-bron och låter er skriva meddelanden interaktivt.

```bash
openclaw acp client

# Point the spawned bridge at a remote Gateway
openclaw acp client --server-args --url wss://gateway-host:18789 --token <token>

# Override the server command (default: openclaw)
openclaw acp client --server "node" --server-args openclaw.mjs acp --url ws://127.0.0.1:19001
```

## Så här använder du detta

Använd ACP när en IDE (eller annan klient) talar Agent Client Protocol och du vill
att den ska driva en OpenClaw Gateway-session.

1. Säkerställ att Gateway kör (lokalt eller på distans).
2. Konfigurera Gateway-målet (konfig eller flaggor).
3. Peka din IDE till att köra `openclaw acp` över stdio.

Exempel på konfig (bestående):

```bash
openclaw config set gateway.remote.url wss://gateway-host:18789
openclaw config set gateway.remote.token <token>
```

Exempel på direktkörning (ingen konfig skrivs):

```bash
openclaw acp --url wss://gateway-host:18789 --token <token>
```

## Välja agenter

AVS väljer inte agenter direkt. Det rutter genom Gateway sessionsnyckel.

Använd agentspecifika sessionsnycklar för att rikta in dig på en specifik agent:

```bash
openclaw acp --session agent:main:main
openclaw acp --session agent:design:main
openclaw acp --session agent:qa:bug-123
```

Varje AVS-session kartor till en enda Gateway-sessionsnyckel. En agent kan ha många
sessioner; AVS standard är en isolerad `acp:<uuid>` session om du inte åsidosätter
nyckeln eller etiketten.

## Zed-redigerarens konfiguration

Lägg till en anpassad ACP-agent i `~/.config/zed/settings.json` (eller använd Zeds inställnings-UI):

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

För att rikta in dig på en specifik Gateway eller agent:

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

I Zed öppnar du Agent-panelen och väljer ”OpenClaw ACP” för att starta en tråd.

## Sessionsmappning

Som standard får AVS-sessioner en isolerad Gateway sessionsnyckel med ett `acp:`-prefix.
För att återanvända en känd session, skicka en sessionsnyckel eller etikett:

- `--session <key>`: använd en specifik Gateway-sessionsnyckel.
- `--session-label <label>`: lös upp en befintlig session via etikett.
- `--reset-session`: skapa ett nytt sessions-id för den nyckeln (samma nyckel, ny transkription).

Om din ACP-klient stöder metadata kan du åsidosätta per session:

```json
{
  "_meta": {
    "sessionKey": "agent:main:main",
    "sessionLabel": "support inbox",
    "resetSession": true
  }
}
```

Läs mer om sessionsnycklar på [/concepts/session](/concepts/session).

## Alternativ

- `--url <url>`: Gateway WebSocket-URL (standard är gateway.remote.url när konfigurerad).
- `--token <token>`: Gateway-autentiseringstoken.
- `--password <password>`: Gateway-autentiseringslösenord.
- `--session <key>`: standard-sessionsnyckel.
- `--session-label <label>`: standard-etikett för session att slå upp.
- `--require-existing`: misslyckas om sessionsnyckeln/etiketten inte finns.
- `--reset-session`: återställ sessionsnyckeln före första användning.
- `--no-prefix-cwd`: prefixera inte prompter med arbetskatalogen.
- `--verbose, -v`: utförlig loggning till stderr.

### `acp client`-alternativ

- `--cwd <dir>`: arbetskatalog för ACP-sessionen.
- `--server <command>`: ACP-serverkommando (standard: `openclaw`).
- `--server-args <args...>`: extra argument som skickas till ACP-servern.
- `--server-verbose`: aktivera utförlig loggning på ACP-servern.
- `--verbose, -v`: utförlig klientloggning.
