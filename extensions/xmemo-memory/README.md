# XMemo Cloud Memory plugin for OpenClaw

This OpenClaw plugin uses [XMemo](https://xmemo.dev) as the active long-term
memory backend. It competes for the `plugins.slots.memory` slot and replaces
local file-backed or vector-backed memory with XMemo's hosted semantic memory.

## Features

- Remote semantic memory via XMemo REST API
- `memory_search` / `memory_get` / `memory_store` / `memory_forget` tools
- Automatic recall context injection through OpenClaw's memory capability hooks
- No local embedding model or vector store required
- Support for hosted XMemo (`https://xmemo.dev`) and private/self-hosted instances

## Configuration

Activate the plugin by setting the memory slot:

```json
{
  "plugins": {
    "slots": {
      "memory": "xmemo-memory"
    },
    "config": {
      "xmemo-memory": {
        "baseUrl": "https://xmemo.dev",
        "bucket": "openclaw",
        "scope": "my-project",
        "autoRecall": true,
        "autoCapture": true
      }
    }
  }
}
```

## Authentication

Set the `XMEMO_KEY` environment variable:

```bash
export XMEMO_KEY="your-xmemo-token"
```

The token can also be configured in the plugin `token` field, but the
environment variable is strongly preferred.

## Required environment variables

- `XMEMO_KEY` — XMemo API/MCP token
- `XMEMO_AGENT_INSTANCE_ID` — optional stable device-level identifier

## Agent identity headers

The plugin sends non-secret attribution headers to XMemo:

- `X-Memory-OS-Agent-ID: openclaw`
- `X-Memory-OS-Agent-Instance-ID: <stable-device-id>`

## Migration from memory-core or memory-lancedb

Switching the memory slot replaces the active backend. Existing local memories
remain on disk but are no longer queried automatically. To migrate content into
XMemo, use `memory_get` on the old backend and `memory_store` on XMemo, or use
XMemo's import endpoints.
