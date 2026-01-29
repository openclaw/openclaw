# Memory (PowerMem) Plugin

Moltbot long-term memory plugin backed by [PowerMem](https://github.com/oceanbase/powermem) via its HTTP API. Provides intelligent memory extraction, Ebbinghaus forgetting curve, and multi-agent isolation without running Python inside Moltbot.

## Requirements

- A running **PowerMem HTTP API server**. Start it separately, for example:

  ```bash
  pip install powermem
  powermem-server --host 0.0.0.0 --port 8000
  ```

  Or with Docker:

  ```bash
  docker run -d -p 8000:8000 --env-file .env oceanbase/powermem-server:latest
  ```

- Configure PowerMem itself (embeddings, storage, etc.) via its `.env`; see [PowerMem configuration](https://github.com/oceanbase/powermem#quick-start).

## Moltbot configuration

1. Enable the plugin and set the memory slot to this plugin. Edit your Moltbot config (e.g. `~/.clawdbot/config.json` or `moltbot.json` in your state dir):

   ```json
   {
     "plugins": {
       "slots": { "memory": "memory-powermem" },
       "entries": {
         "memory-powermem": {
           "enabled": true,
           "config": {
             "baseUrl": "http://localhost:8000",
             "autoCapture": true,
             "autoRecall": true,
             "inferOnAdd": true
           }
         }
       }
     }
   }
   ```

   Optional: `apiKey` (if PowerMem server has auth), `userId`, `agentId` — see Options below.

2. Ensure PowerMem server is running before starting the gateway.

**Auto-capture:** When a conversation ends, the full user/assistant text is sent to PowerMem with `infer: true`; PowerMem extracts and stores memories (no trigger phrases) (e.g. “remember …”, “I like …”, “important”, or Chinese “记得/记住/我喜欢/重要/偏好”). At most 3 chunks per session (each up to 6000 chars). To test: run `moltbot ltm health`, then `moltbot ltm add "User prefers dark mode"` and `moltbot ltm search "dark mode"`. In chat, ask the agent to “remember that I prefer tea” or say “我喜欢用 Python” so a message is auto-captured.

## Options

| Option        | Required | Description                                                                 |
|---------------|----------|-----------------------------------------------------------------------------|
| `baseUrl`     | Yes      | PowerMem API base URL (e.g. `http://localhost:8000`), no `/api/v1` suffix. |
| `apiKey`      | No       | Set if PowerMem server has API key authentication enabled.                 |
| `userId`      | No       | PowerMem `user_id` for isolation; default `moltbot-user`.                 |
| `agentId`     | No       | PowerMem `agent_id` for isolation; default `moltbot-agent`.                |
| `autoCapture` | No       | Auto-store from conversations after agent ends; default `true`.            |
| `autoRecall`  | No       | Auto-inject relevant memories before agent starts; default `true`.        |
| `inferOnAdd`  | No       | Use PowerMem intelligent extraction when adding; default `true`.           |

## Tools

- **memory_recall** — Search long-term memories by query.
- **memory_store** — Save information (with optional infer).
- **memory_forget** — Delete by memory ID or by search query.

## CLI

- `moltbot ltm search <query> [--limit n]` — Search memories.
- `moltbot ltm health` — Check PowerMem server health.
- `moltbot ltm add "<text>"` — Manually store one memory (for testing or one-off storage).

## Running tests

From the repo root:

```bash
# Run all tests (includes extensions)
pnpm test

# Run only this plugin's tests
pnpm exec vitest run --config vitest.extensions.config.ts extensions/memory-powermem
```

## Docs

- [PowerMem](https://github.com/oceanbase/powermem)
- [PowerMem HTTP API](https://github.com/oceanbase/powermem/blob/master/docs/api/0005-api_server.md)
- [Moltbot long-term memory design](/docs/design/memory-powermem-integration.md)
