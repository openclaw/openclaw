# XMemo Cloud Memory plugin for OpenClaw

This OpenClaw plugin uses [XMemo](https://xmemo.dev) as the active long-term
memory backend. It competes for the `plugins.slots.memory` slot and replaces
local file-backed or vector-backed memory with XMemo's hosted semantic memory.

## Features

- Remote semantic memory via XMemo REST API
- `memory_search` / `memory_get` / `memory_store` / `memory_forget` canonical memory tools
- `xmemo_todo_create` / `xmemo_todo_list` / `xmemo_todo_complete` reminder tools
- `xmemo_record_event` timeline event tool
- Optional automatic capture of high-signal user messages after a successful agent turn
- No local embedding model or vector store required
- Support for hosted XMemo (`https://xmemo.dev`) and private/self-hosted instances

## Native plugin vs MCP

This is a native OpenClaw plugin (`kind: "memory"`). It becomes the active
memory backend when `plugins.slots.memory` is set to `"xmemo-memory"`. XMemo
also offers an MCP server; the MCP server exposes similar tools but does **not**
occupy the OpenClaw memory slot or replace `active-memory` recall.

## Configuration

Activate the plugin by setting the memory slot:

```json
{
  "plugins": {
    "slots": {
      "memory": "xmemo-memory"
    },
    "entries": {
      "xmemo-memory": {
        "enabled": true,
        "config": {
          "baseUrl": "https://xmemo.dev",
          "apiKey": "xmemo_...",
          "bucket": "openclaw",
          "scope": "my-project",
          "autoCapture": false
        }
      }
    }
  }
}
```

Config lives at `plugins.entries["xmemo-memory"].config`, not `plugins.config`.

## Authentication

Create a scoped API key in the XMemo Memory Console:
[xmemo.dev](https://xmemo.dev) → **API Keys** → **Create API key**.
Copy the one-time secret value, then set it as the `XMEMO_KEY` environment
variable:

```bash
export XMEMO_KEY="your-xmemo-api-key"
```

The key can also be configured with `apiKey` (preferred) or the deprecated
`token` field. For production setups, keep the key in the environment or a
secret manager and omit the `apiKey` field from `openclaw.json`; the plugin
will read `XMEMO_KEY` directly.

## Required environment variables

- `XMEMO_KEY` — XMemo API key (preferred)
- `MEMORY_OS_API_KEY` — alternate env var name
- `XMEMO_AGENT_INSTANCE_ID` — optional stable device-level identifier

## Auth mode

By default the credential is sent as `X-API-Key`. To use Bearer auth or both:

```json
{
  "authMode": "bearer"
}
```

Allowed values: `api-key` (default), `bearer`, `both`.

## Agent identity headers

The plugin sends non-secret attribution headers to XMemo:

- `X-Memory-OS-Agent-ID: openclaw`
- `X-Memory-OS-Agent-Instance-ID: <stable-device-id>`

If `XMEMO_AGENT_INSTANCE_ID` is not set, a process-local UUID is generated. The
plugin does not write JSON sidecars to disk.

## CLI

```bash
openclaw memory xmemo status
openclaw memory xmemo status --json
```

## Auto-capture

When `autoCapture: true`, the plugin listens for `agent_end` and stores
high-signal user messages (preferences, decisions, facts) to XMemo. It skips:

- envelope/transport metadata
- injected context blocks
- prompt-injection-looking payloads
- messages without a memory trigger word

Customize triggers with `customTriggers`:

```json
{
  "autoCapture": true,
  "customTriggers": ["save this", "remember for next time"]
}
```

## Migration from memory-core or memory-lancedb

Switching the memory slot replaces the active backend. Existing local memories
remain on disk but are no longer queried automatically. To migrate content into
XMemo, use `memory_get` on the old backend and `memory_store` on XMemo, or use
XMemo's import endpoints.
