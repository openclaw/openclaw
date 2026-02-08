---
summary: "Patakbuhin ang ACP bridge para sa mga IDE integration"
read_when:
  - Pagse-setup ng mga ACP-based na IDE integration
  - Pag-debug ng ACP session routing papunta sa Gateway
title: "acp"
x-i18n:
  source_path: cli/acp.md
  source_hash: 0c09844297da250b
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:45:22Z
---

# acp

Patakbuhin ang ACP (Agent Client Protocol) bridge na nakikipag-usap sa isang OpenClaw Gateway.

Nakikipag-usap ang command na ito gamit ang ACP sa ibabaw ng stdio para sa mga IDE at ipinapasa ang mga prompt papunta sa Gateway
sa pamamagitan ng WebSocket. Pinapanatili nitong naka-map ang mga ACP session sa mga Gateway session key.

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

## ACP client (debug)

Gamitin ang built-in na ACP client para mag-sanity-check ng bridge nang walang IDE.
Ini-spawn nito ang ACP bridge at hinahayaan kang mag-type ng mga prompt nang interactive.

```bash
openclaw acp client

# Point the spawned bridge at a remote Gateway
openclaw acp client --server-args --url wss://gateway-host:18789 --token <token>

# Override the server command (default: openclaw)
openclaw acp client --server "node" --server-args openclaw.mjs acp --url ws://127.0.0.1:19001
```

## Paano ito gamitin

Gamitin ang ACP kapag ang isang IDE (o ibang client) ay nagsasalita ng Agent Client Protocol at gusto mong
patakbuhin nito ang isang OpenClaw Gateway session.

1. Tiyaking tumatakbo ang Gateway (local o remote).
2. I-configure ang Gateway target (config o mga flag).
3. Ituro ang iyong IDE na patakbuhin ang `openclaw acp` sa ibabaw ng stdio.

Halimbawang config (naka-persist):

```bash
openclaw config set gateway.remote.url wss://gateway-host:18789
openclaw config set gateway.remote.token <token>
```

Halimbawang direktang patakbo (walang pagsusulat ng config):

```bash
openclaw acp --url wss://gateway-host:18789 --token <token>
```

## Pagpili ng mga agent

Hindi direktang pumipili ng mga agent ang ACP. Nagru-route ito gamit ang Gateway session key.

Gumamit ng mga session key na saklaw ng agent para i-target ang isang partikular na agent:

```bash
openclaw acp --session agent:main:main
openclaw acp --session agent:design:main
openclaw acp --session agent:qa:bug-123
```

Bawat ACP session ay naka-map sa iisang Gateway session key. Maaaring magkaroon ang isang agent ng maraming
session; default ng ACP ang isang isolated na `acp:<uuid>` session maliban kung i-override mo
ang key o label.

## Setup ng Zed editor

Magdagdag ng custom ACP agent sa `~/.config/zed/settings.json` (o gamitin ang Settings UI ng Zed):

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

Para i-target ang isang partikular na Gateway o agent:

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

Sa Zed, buksan ang Agent panel at piliin ang “OpenClaw ACP” para magsimula ng thread.

## Session mapping

Bilang default, nakakakuha ang mga ACP session ng isang isolated na Gateway session key na may prefix na `acp:`.
Para muling gamitin ang isang kilalang session, magpasa ng session key o label:

- `--session <key>`: gumamit ng isang partikular na Gateway session key.
- `--session-label <label>`: i-resolve ang isang umiiral na session ayon sa label.
- `--reset-session`: lumikha ng bagong session id para sa key na iyon (parehong key, bagong transcript).

Kung sinusuportahan ng iyong ACP client ang metadata, maaari kang mag-override kada session:

```json
{
  "_meta": {
    "sessionKey": "agent:main:main",
    "sessionLabel": "support inbox",
    "resetSession": true
  }
}
```

Alamin pa ang tungkol sa mga session key sa [/concepts/session](/concepts/session).

## Mga opsyon

- `--url <url>`: Gateway WebSocket URL (default sa gateway.remote.url kapag naka-configure).
- `--token <token>`: Gateway auth token.
- `--password <password>`: Gateway auth password.
- `--session <key>`: default na session key.
- `--session-label <label>`: default na session label na ire-resolve.
- `--require-existing`: mag-fail kung hindi umiiral ang session key/label.
- `--reset-session`: i-reset ang session key bago ang unang paggamit.
- `--no-prefix-cwd`: huwag lagyan ng prefix ang mga prompt gamit ang working directory.
- `--verbose, -v`: verbose na logging sa stderr.

### Mga opsyon ng `acp client`

- `--cwd <dir>`: working directory para sa ACP session.
- `--server <command>`: ACP server command (default: `openclaw`).
- `--server-args <args...>`: mga karagdagang argument na ipinapasa sa ACP server.
- `--server-verbose`: i-enable ang verbose logging sa ACP server.
- `--verbose, -v`: verbose na client logging.
