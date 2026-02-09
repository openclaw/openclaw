---
summary: "Voer de ACP-bridge uit voor IDE-integraties"
read_when:
  - ACP-gebaseerde IDE-integraties instellen
  - ACP-sessierouting naar de Gateway debuggen
title: "acp"
---

# acp

Voer de ACP-bridge (Agent Client Protocol) uit die met een OpenClaw Gateway communiceert.

Deze opdracht spreekt ACP over stdio voor IDE’s en stuurt prompts door naar de Gateway
via WebSocket. ACP-sessies worden gekoppeld aan Gateway-sessiesleutels.

## Gebruik

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

## ACP-client (debug)

Gebruik de ingebouwde ACP-client om de bridge te controleren zonder een IDE.
Deze start de ACP-bridge en laat je prompts interactief invoeren.

```bash
openclaw acp client

# Point the spawned bridge at a remote Gateway
openclaw acp client --server-args --url wss://gateway-host:18789 --token <token>

# Override the server command (default: openclaw)
openclaw acp client --server "node" --server-args openclaw.mjs acp --url ws://127.0.0.1:19001
```

## Hoe je dit gebruikt

Gebruik ACP wanneer een IDE (of andere client) Agent Client Protocol spreekt en je wilt
dat deze een OpenClaw Gateway-sessie aanstuurt.

1. Zorg ervoor dat de Gateway draait (lokaal of op afstand).
2. Configureer het Gateway-doel (config of flags).
3. Stel je IDE in om `openclaw acp` over stdio uit te voeren.

Voorbeeldconfig (persistent):

```bash
openclaw config set gateway.remote.url wss://gateway-host:18789
openclaw config set gateway.remote.token <token>
```

Voorbeeld van direct uitvoeren (geen config-wegschrijvingen):

```bash
openclaw acp --url wss://gateway-host:18789 --token <token>
```

## Agents selecteren

ACP kiest geen agents direct. Het routeert op basis van de Gateway-sessiesleutel.

Gebruik agent-gescopeerde sessiesleutels om een specifieke agent te targeten:

```bash
openclaw acp --session agent:main:main
openclaw acp --session agent:design:main
openclaw acp --session agent:qa:bug-123
```

Elke ACP-sessie wordt gekoppeld aan één Gateway-sessiesleutel. Eén agent kan meerdere
sessies hebben; ACP gebruikt standaard een geïsoleerde `acp:<uuid>`-sessie, tenzij je
de sleutel of het label overschrijft.

## Zed-editor installatie

Voeg een aangepaste ACP-agent toe in `~/.config/zed/settings.json` (of gebruik de instellingen-UI van Zed):

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

Om een specifieke Gateway of agent te targeten:

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

Open in Zed het Agent-paneel en selecteer “OpenClaw ACP” om een thread te starten.

## Sessiemapping

Standaard krijgen ACP-sessies een geïsoleerde Gateway-sessiesleutel met een `acp:`-prefix.
Om een bekende sessie te hergebruiken, geef een sessiesleutel of label door:

- `--session <key>`: gebruik een specifieke Gateway-sessiesleutel.
- `--session-label <label>`: resolveer een bestaande sessie op label.
- `--reset-session`: maak een nieuw sessie-id aan voor die sleutel (dezelfde sleutel, nieuw transcript).

Als je ACP-client metadata ondersteunt, kun je dit per sessie overschrijven:

```json
{
  "_meta": {
    "sessionKey": "agent:main:main",
    "sessionLabel": "support inbox",
    "resetSession": true
  }
}
```

Lees meer over sessiesleutels op [/concepts/session](/concepts/session).

## Opties

- `--url <url>`: Gateway WebSocket-URL (standaard gateway.remote.url wanneer geconfigureerd).
- `--token <token>`: Gateway-authenticatietoken.
- `--password <password>`: Gateway-authenticatiewachtwoord.
- `--session <key>`: standaard sessiesleutel.
- `--session-label <label>`: standaard sessielabel om te resolven.
- `--require-existing`: faal als de sessiesleutel/-label niet bestaat.
- `--reset-session`: reset de sessiesleutel vóór het eerste gebruik.
- `--no-prefix-cwd`: voorzie prompts niet van de werkmap.
- `--verbose, -v`: uitgebreide logging naar stderr.

### `acp client`-opties

- `--cwd <dir>`: werkmap voor de ACP-sessie.
- `--server <command>`: ACP-serveropdracht (standaard: `openclaw`).
- `--server-args <args...>`: extra argumenten die aan de ACP-server worden doorgegeven.
- `--server-verbose`: schakel uitgebreide logging op de ACP-server in.
- `--verbose, -v`: uitgebreide clientlogging.
