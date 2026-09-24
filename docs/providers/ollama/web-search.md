---
summary: "Use Ollama as the OpenClaw web_search provider"
read_when:
  - You want Ollama to serve the web_search tool
  - You need the host, auth, and requirement rules for Ollama search
title: "Ollama Web Search"
sidebarTitle: "Web search"
---

## Ollama Web Search

OpenClaw bundles **Ollama Web Search** as a `web_search` provider.

| Property    | Detail                                                                                                                                                     |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Host        | `models.providers.ollama.baseUrl` when set, otherwise `http://127.0.0.1:11434`; `https://ollama.com` uses the hosted API directly                          |
| Auth        | Key-free for a signed-in local host; `OLLAMA_API_KEY` or configured provider auth for direct `https://ollama.com` search or auth-protected hosts           |
| Requirement | Local/self-hosted hosts must be running and signed in with `ollama signin`; direct hosted search needs `baseUrl: "https://ollama.com"` plus a real API key |

Choose it during `openclaw onboard` or `openclaw configure --section web`, or set:

```json5
{
  tools: {
    web: {
      search: {
        provider: "ollama",
      },
    },
  },
}
```

For direct hosted search through Ollama Cloud:

```json5
{
  models: {
    providers: {
      ollama: {
        baseUrl: "https://ollama.com",
        apiKey: "OLLAMA_API_KEY",
        api: "ollama",
        models: [{ id: "kimi-k2.5:cloud", name: "kimi-k2.5:cloud", input: ["text"] }],
      },
    },
  },
  tools: {
    web: {
      search: { provider: "ollama" },
    },
  },
}
```

For a self-hosted host, OpenClaw first tries the local `/api/experimental/web_search`
proxy, then falls back to the hosted `/api/web_search` path on the same host; a
signed-in local daemon normally answers through the local proxy. Direct
`https://ollama.com` calls always use the hosted `/api/web_search` endpoint.

<Note>
For full setup and behavior, see [Ollama Web Search](/tools/ollama-search).
</Note>
