---
summary: "Kør ACP-broen til IDE-integrationer"
read_when:
  - Opsætning af ACP-baserede IDE-integrationer
  - Fejlfinding af ACP-sessionrouting til Gateway
title: "acp"
---

# acp

Kør ACP-broen (Agent Client Protocol), der taler med en OpenClaw Gateway.

Denne kommando taler AVS over stdio for IDE og fremad beder til Gateway
over WebSocket. Det holder AVS-sessioner kortlagt til Gateway session nøgler.

## Usage

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

Brug den indbyggede AVS-klient til sanity-kontrollere broen uden en IDE.
Det spawner AVS-broen og lader dig skrive beder interaktivt.

```bash
openclaw acp client

# Point the spawned bridge at a remote Gateway
openclaw acp client --server-args --url wss://gateway-host:18789 --token <token>

# Override the server command (default: openclaw)
openclaw acp client --server "node" --server-args openclaw.mjs acp --url ws://127.0.0.1:19001
```

## Sådan bruger du dette

Brug ACP, når en IDE (eller anden klient) taler Agent Client Protocol, og du vil have
den til at styre en OpenClaw Gateway-session.

1. Sørg for, at Gateway kører (lokal eller remote).
2. Konfigurér Gateway-målet (konfiguration eller flags).
3. Peg din IDE til at køre `openclaw acp` over stdio.

Eksempelkonfiguration (persistet):

```bash
openclaw config set gateway.remote.url wss://gateway-host:18789
openclaw config set gateway.remote.token <token>
```

Eksempel på direkte kørsel (ingen skrivning af konfiguration):

```bash
openclaw acp --url wss://gateway-host:18789 --token <token>
```

## Valg af agenter

AVS vælger ikke agenter direkte. Det ruter af Gateway session nøglen.

Brug agent-afgrænsede sessionsnøgler for at målrette en specifik agent:

```bash
openclaw acp --session agent:main:main
openclaw acp --session agent:design:main
openclaw acp --session agent:qa:bug-123
```

Hver AVS-session kort til en enkelt Gateway session nøgle. Én agent kan have mange
-sessioner; AVS er standard til en isoleret 'acp:<uuid>-session, medmindre du tilsidesætter
nøglen eller etiketten.

## Zed-editoropsætning

Tilføj en brugerdefineret ACP-agent i `~/.config/zed/settings.json` (eller brug Zeds Settings UI):

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

For at målrette en specifik Gateway eller agent:

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

I Zed skal du åbne Agent-panelet og vælge “OpenClaw ACP” for at starte en tråd.

## Session-mapping

Som standard får AVS-sessioner en isoleret Gateway-sessionsnøgle med en 'acp:'-præfiks.
For at genbruge en kendt session, gå en sessionsnøgle eller -etiket:

- `--session <key>`: brug en specifik Gateway-sessionsnøgle.
- `--session-label <label>`: slå en eksisterende session op via etiket.
- `--reset-session`: udsted et nyt sessions-id for den nøgle (samme nøgle, ny transskription).

Hvis din ACP-klient understøtter metadata, kan du tilsidesætte pr. session:

```json
{
  "_meta": {
    "sessionKey": "agent:main:main",
    "sessionLabel": "support inbox",
    "resetSession": true
  }
}
```

Læs mere om sessionsnøgler på [/concepts/session](/concepts/session).

## Indstillinger

- `--url <url>`: Gateway WebSocket-URL (standard er gateway.remote.url, når konfigureret).
- `--token <token>`: Gateway-autentificeringstoken.
- `--password <password>`: Gateway-autentificeringsadgangskode.
- `--session <key>`: standard sessionsnøgle.
- `--session-label <label>`: standard sessionsetiket, der skal slås op.
- `--require-existing`: fejler, hvis sessionsnøglen/etiketten ikke findes.
- `--reset-session`: nulstil sessionsnøglen før første brug.
- `--no-prefix-cwd`: foranstil ikke prompts med arbejdsbiblioteket.
- `--verbose, -v`: udførlig logning til stderr.

### `acp client`-indstillinger

- `--cwd <dir>`: arbejdsbibliotek for ACP-sessionen.
- `--server <command>`: ACP-serverkommando (standard: `openclaw`).
- `--server-args <args...>`: ekstra argumenter sendt til ACP-serveren.
- `--server-verbose`: aktivér udførlig logning på ACP-serveren.
- `--verbose, -v`: udførlig klientlogning.
