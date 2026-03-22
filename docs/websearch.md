---
summary: "Web search configuration for Tavily, SearXNG, and Grok"
read_when:
  - You want to use Tavily or Grok for web search
  - You want to set up a self-hosted SearXNG instance
title: "Web Search Overview"
---

# Web search providers

OpenClaw supports multiple web search providers via the `web_search` tool. You can configure them in `~/.openclaw/openclaw.json` or using environment variables.

## Supported Providers

- **[Tavily](/tavily-search)**: Optimized for AI agents. Fast and reliable.
- **[SearXNG (Self-hosted)](/searxng-search)**: Free, privacy-respecting metasearch engine you can host yourself.
- **[Perplexity / OpenRouter](#perplexity--openrouter)**: High-quality AI-driven search.
- **[Grok Search (xAI)](#grok-search-xai)**: Web search via the xAI Responses API.

---

## Perplexity / OpenRouter

OpenClaw supports [Perplexity AI](https://www.perplexity.ai/) for web search. It can connect directly to Perplexity's API or via [OpenRouter](https://openrouter.ai/).

- **Default:** If the API key is unrecognized or missing, OpenClaw defaults to **OpenRouter** (`https://openrouter.ai/api/v1`).
- **Direct Perplexity:** API keys starting with `pplx-` are automatically routed to `https://api.perplexity.ai`.
- **OpenRouter:** API keys starting with `sk-or-` are routed to OpenRouter.

### Configuration

```json
{
  "tools": {
    "web": {
      "search": {
        "provider": "perplexity",
        "perplexity": {
          "apiKey": "pplx-your-perplexity-key",
          "model": "sonar-pro"
        }
      }
    }
  }
}
```

- **`apiKey`**: Your Perplexity or OpenRouter key.
- **`baseUrl`**: (Optional) Override the default API endpoint.
- **`model`**: (Optional) Defaults to `sonar-pro`.

## Grok Search (xAI)

[xAI Grok](https://x.ai/) provides a web search tool via the Responses API.

1. **Environment Variable:** Set `XAI_API_KEY` in your environment.
2. **Configuration:** Update `~/.openclaw/openclaw.json`:

```json
{
  "tools": {
    "web": {
      "search": {
        "provider": "grok",
        "grok": {
          "apiKey": "your-xai-api-key"
        }
      }
    }
  }
}
```

---

## Gateway & Authentication Errors

While configuring web search, you may encounter gateway-level security errors if your connection is not properly authorized or secured.

### Origin not allowed

**Error:** `origin not allowed (open the Control UI from the gateway host or allow it in gateway.controlUi.allowedOrigins)`

This happens when you try to access the OpenClaw Control UI from a browser on a different machine or IP that isn't in the allowlist.

**Resolution:**
Update `gateway.controlUi.allowedOrigins` in your `openclaw.json` to include the IP address of the machine you are browsing from, or use `"*"` to allow any origin (not recommended for public networks).

```json
{
  "gateway": {
    "controlUi": {
      "allowedOrigins": ["http://10.251.1.32:18789", "http://your-client-ip:port"]
    }
  }
}
```

### Device identity required

**Error:** `device identity required` or `control ui requires device identity (use HTTPS or localhost secure context)`

OpenClaw uses device identity to secure the connection between your browser and the gateway. This requires a **Secure Context** (HTTPS or `localhost`) for the browser's cryptographic APIs to work.

**Resolution:**

1. **Use Localhost:** Access the UI via `http://localhost:18789` if the gateway is running on the same machine.
2. **Use HTTPS:** Set up a reverse proxy with TLS (e.g., Nginx, Caddy) to serve the gateway over HTTPS.
3. **Insecure Auth (Advanced):** If you must use HTTP on a private network, you can enable insecure auth (not recommended):

```json
{
  "gateway": {
    "controlUi": {
      "allowInsecureAuth": true,
      "dangerouslyDisableDeviceAuth": true
    }
  }
}
```

> [!WARNING]
> Disabling device auth or allowing insecure auth exposes your gateway to potential session hijacking. Only use these settings on trusted private networks.

### Plaintext WebSocket blocked on Private Network

**Error:** `SECURITY ERROR: Gateway URL "ws://..." uses plaintext ws:// to a non-loopback address.`

To use it in a trusted private network (LAN) environment, you must temporarily allow this security check via environment variables.

Try running the following command in your terminal:

```bash
# Run onboarding with the security check bypass option enabled
export OPENCLAW_ALLOW_INSECURE_PRIVATE_WS=1
pnpm openclaw onboard --install-daemon
```

Or run it in one line:

```bash
OPENCLAW_ALLOW_INSECURE_PRIVATE_WS=1 pnpm openclaw onboard --install-daemon
```

---

## Final checklist

- Verify `~/.openclaw/openclaw.json` contains the correct `allowPrivateNetwork` settings.
- Restart the OpenClaw daemon to apply configuration changes:

  ```bash
  pkill -f openclaw
  pnpm openclaw onboard --install-daemon
  ```

- Test a simple search in Mattermost:

  ```
  /ask search "weather tomorrow" freshness=pd
  ```

## Usage Example

In Mattermost, you can ask OpenClaw to perform a web search like this:

```
/ask search "weather tomorrow" freshness=pd
```

The `freshness=pd` flag limits results to the past day. Adjust the provider or parameters as needed.

> **Note:** After modifying `~/.openclaw/openclaw.json`, restart the OpenClaw daemon to apply changes:
>
> ```bash
> pkill -f openclaw
> pnpm openclaw onboard --install-daemon
> ```
