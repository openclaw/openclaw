---
summary: "Kør ACP-broen til IDE-integrationer"
read_when:
  - Opsætning af ACP-baserede IDE-integrationer
  - Fejlfinding af ACP-sessionrouting til Gateway
title: "acp"
x-i18n:
  source_path: cli/acp.md
  source_hash: 0c09844297da250b
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:49:59Z
---

# acp

Kør ACP-broen (Agent Client Protocol), der taler med en OpenClaw Gateway.

Denne kommando taler ACP over stdio for IDE’er og videresender prompts til Gateway
over WebSocket. Den holder ACP-sessioner mappet til Gateway-sessionsnøgler.

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

Brug den indbyggede ACP-klient til at sanity-checke broen uden en IDE.
Den starter ACP-broen og lader dig skrive prompts interaktivt.

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

ACP vælger ikke agenter direkte. Den router via Gateway-sessionsnøglen.

Brug agent-afgrænsede sessionsnøgler for at målrette en specifik agent:

```bash
openclaw acp --session agent:main:main
openclaw acp --session agent:design:main
openclaw acp --session agent:qa:bug-123
```

Hver ACP-session mapper til én Gateway-sessionsnøgle. Én agent kan have mange
sessioner; ACP bruger som standard en isoleret `acp:<uuid>`-session, medmindre du tilsidesætter
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

Som standard får ACP-sessioner en isoleret Gateway-sessionsnøgle med et `acp:`-præfiks.
For at genbruge en kendt session skal du angive en sessionsnøgle eller etiket:

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
