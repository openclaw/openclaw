---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Run the ACP bridge for IDE integrations"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Setting up ACP-based IDE integrations（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Debugging ACP session routing to the Gateway（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "acp"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# acp（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Run the ACP (Agent Client Protocol) bridge that talks to a OpenClaw Gateway.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This command speaks ACP over stdio for IDEs and forwards prompts to the Gateway（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
over WebSocket. It keeps ACP sessions mapped to Gateway session keys.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Usage（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw acp（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Remote Gateway（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw acp --url wss://gateway-host:18789 --token <token>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Attach to an existing session key（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw acp --session agent:main:main（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Attach by label (must already exist)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw acp --session-label "support inbox"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Reset the session key before the first prompt（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw acp --session agent:main:main --reset-session（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## ACP client (debug)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use the built-in ACP client to sanity-check the bridge without an IDE.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
It spawns the ACP bridge and lets you type prompts interactively.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw acp client（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Point the spawned bridge at a remote Gateway（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw acp client --server-args --url wss://gateway-host:18789 --token <token>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Override the server command (default: openclaw)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw acp client --server "node" --server-args openclaw.mjs acp --url ws://127.0.0.1:19001（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## How to use this（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use ACP when an IDE (or other client) speaks Agent Client Protocol and you want（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
it to drive a OpenClaw Gateway session.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Ensure the Gateway is running (local or remote).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Configure the Gateway target (config or flags).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Point your IDE to run `openclaw acp` over stdio.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Example config (persisted):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw config set gateway.remote.url wss://gateway-host:18789（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw config set gateway.remote.token <token>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Example direct run (no config write):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw acp --url wss://gateway-host:18789 --token <token>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Selecting agents（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
ACP does not pick agents directly. It routes by the Gateway session key.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use agent-scoped session keys to target a specific agent:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw acp --session agent:main:main（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw acp --session agent:design:main（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw acp --session agent:qa:bug-123（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Each ACP session maps to a single Gateway session key. One agent can have many（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
sessions; ACP defaults to an isolated `acp:<uuid>` session unless you override（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
the key or label.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Zed editor setup（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Add a custom ACP agent in `~/.config/zed/settings.json` (or use Zed’s Settings UI):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "agent_servers": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "OpenClaw ACP": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "type": "custom",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "command": "openclaw",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "args": ["acp"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "env": {}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
To target a specific Gateway or agent:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "agent_servers": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "OpenClaw ACP": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "type": "custom",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "command": "openclaw",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "args": [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "acp",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "--url",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "wss://gateway-host:18789",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "--token",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "<token>",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "--session",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "agent:design:main"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      ],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "env": {}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
In Zed, open the Agent panel and select “OpenClaw ACP” to start a thread.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Session mapping（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
By default, ACP sessions get an isolated Gateway session key with an `acp:` prefix.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
To reuse a known session, pass a session key or label:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--session <key>`: use a specific Gateway session key.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--session-label <label>`: resolve an existing session by label.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--reset-session`: mint a fresh session id for that key (same key, new transcript).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If your ACP client supports metadata, you can override per session:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "_meta": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "sessionKey": "agent:main:main",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "sessionLabel": "support inbox",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "resetSession": true（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Learn more about session keys at [/concepts/session](/concepts/session).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Options（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--url <url>`: Gateway WebSocket URL (defaults to gateway.remote.url when configured).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--token <token>`: Gateway auth token.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--password <password>`: Gateway auth password.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--session <key>`: default session key.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--session-label <label>`: default session label to resolve.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--require-existing`: fail if the session key/label does not exist.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--reset-session`: reset the session key before first use.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--no-prefix-cwd`: do not prefix prompts with the working directory.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--verbose, -v`: verbose logging to stderr.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### `acp client` options（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--cwd <dir>`: working directory for the ACP session.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--server <command>`: ACP server command (default: `openclaw`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--server-args <args...>`: extra arguments passed to the ACP server.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--server-verbose`: enable verbose logging on the ACP server.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--verbose, -v`: verbose client logging.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
