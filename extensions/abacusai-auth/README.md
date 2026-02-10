# AbacusAI Auth (OpenClaw Plugin)

Bundled provider plugin that integrates **AbacusAI** models into OpenClaw via an
embedded local proxy. The proxy transparently forwards OpenAI-compatible requests
to AbacusAI's **RouteLLM** endpoint, applying protocol normalization so that the
OpenClaw Agent can use AbacusAI-hosted models (Claude, Gemini, GPT, DeepSeek,
Qwen, Grok, Kimi, and more) with full **multi-tool calling** support.

| Field           | Value                                       |
| --------------- | ------------------------------------------- |
| **Package**     | `@openclaw/abacusai-auth`                   |
| **Entry**       | `./index.ts`                                |
| **Provider ID** | `abacusai`                                  |
| **Aliases**     | `abacus`, `abacus-ai`, `abacusai-code-mode` |
| **API style**   | `openai-completions` (via local proxy)      |
| **Upstream**    | `https://routellm.abacus.ai/v1`             |

---

## Table of Contents

- [Quick Start](#quick-start)
- [Architecture](#architecture)
- [Supported Models](#supported-models)
- [Credential Resolution](#credential-resolution)
- [Embedded RouteLLM Proxy](#embedded-routellm-proxy)
  - [Request Pipeline](#request-pipeline)
  - [SSE Streaming Normalizer](#sse-streaming-normalizer)
  - [finish_reason Normalization](#finish_reason-normalization)
- [Proxy Lifecycle](#proxy-lifecycle)
  - [Auto-Start on Gateway Launch](#auto-start-on-gateway-launch)
  - [Idle Timeout](#idle-timeout)
  - [before_agent_start Safety Net](#before_agent_start-safety-net)
- [Defensive Programming](#defensive-programming)
- [Configuration Reference](#configuration-reference)
- [Troubleshooting](#troubleshooting)
- [Getting an API Key](#getting-an-api-key)

---

## Quick Start

### 1. Enable the plugin

Bundled plugins are disabled by default:

```bash
openclaw plugins enable abacusai-auth
```

### 2. Authenticate

```bash
openclaw models auth login --provider abacusai --set-default
```

The interactive login flow will:

1. Attempt to **auto-detect** credentials from a local AbacusAI Code Mode installation.
2. Fall back to the `ABACUSAI_API_KEY` environment variable.
3. Prompt for **manual entry** if neither is found.
4. **Validate** the API key against `https://api.abacus.ai/api/v0/describeUser`.
5. Let you select which models to register (defaults to all supported models).
6. Write a placeholder `baseUrl` (`http://127.0.0.1:0/v1`) to `openclaw.json` — the
   real port is assigned when the proxy starts with the gateway.

### 3. Restart the Gateway

```bash
openclaw gateway run
```

The proxy starts automatically during gateway startup. You should see a log line:

```
AbacusAI RouteLLM proxy started on port <dynamic-port>
```

### 4. Use AbacusAI models

```bash
openclaw send "Hello" --model abacusai/claude-opus-4-6
```

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│  OpenClaw Agent (Pi Agent)                                       │
│  Sends standard OpenAI-compatible requests                       │
│  (POST /v1/chat/completions with tools[])                        │
└──────────────┬───────────────────────────────────────────────────┘
               │ http://127.0.0.1:<port>/v1
               ▼
┌──────────────────────────────────────────────────────────────────┐
│  Embedded RouteLLM Proxy (this plugin)                           │
│                                                                  │
│  1. Injects Authorization: Bearer <api-key>                      │
│  2. Strips `strict` field from tool schemas                      │
│  3. Forwards to RouteLLM upstream                                │
│  4. Normalizes SSE streaming (TCP chunk reassembly)              │
│  5. Normalizes finish_reason (Anthropic → OpenAI)                │
│  6. Strips non-standard native_finish_reason field               │
│  7. Detects 401/403 → returns auth_expired error                 │
└──────────────┬───────────────────────────────────────────────────┘
               │ https://routellm.abacus.ai/v1
               ▼
┌──────────────────────────────────────────────────────────────────┐
│  AbacusAI RouteLLM Endpoint                                      │
│  OpenAI-compatible API with function calling                     │
│  Routes to Claude, Gemini, GPT, DeepSeek, etc.                  │
└──────────────────────────────────────────────────────────────────┘
```

**Why a local proxy?** AbacusAI's RouteLLM endpoint is mostly OpenAI-compatible,
but has several protocol deviations that break the OpenClaw Agent's tool-calling
pipeline. The proxy transparently fixes these without modifying core OpenClaw code.

---

## Supported Models

The following models are registered by default (verified February 2026):

| Model ID                      | Family               |
| ----------------------------- | -------------------- |
| `gemini-3-flash-preview`      | Google Gemini        |
| `gemini-3-pro-preview`        | Google Gemini        |
| `gemini-2.5-flash`            | Google Gemini        |
| `gemini-2.5-pro`              | Google Gemini        |
| `gpt-5.2`                     | OpenAI GPT           |
| `gpt-5.1`                     | OpenAI GPT           |
| `gpt-5-mini`                  | OpenAI GPT           |
| `claude-sonnet-4-5-20250929`  | Anthropic Claude     |
| `claude-opus-4-6`             | Anthropic Claude     |
| `claude-haiku-4-5-20251001`   | Anthropic Claude     |
| `deepseek-ai/DeepSeek-V3.2`   | DeepSeek             |
| `deepseek-ai/DeepSeek-R1`     | DeepSeek             |
| `kimi-k2.5`                   | Moonshot Kimi        |
| `qwen3-max`                   | Alibaba Qwen         |
| `grok-4-1-fast-non-reasoning` | xAI Grok             |
| `route-llm`                   | AbacusAI Auto-Router |

All models are configured with:

- **Context window**: 200,000 tokens
- **Max output tokens**: 8,192 tokens
- **Input modalities**: text, image
- **API**: `openai-completions`

You can customize the model list during the interactive login flow.

---

## Credential Resolution

The plugin resolves API keys using a multi-tier fallback strategy, checked in order:

### During Login (`openclaw models auth login`)

1. **Local AbacusAI Code Mode installation** — scans platform-specific paths:
   - **Windows**: `%APPDATA%\AbacusAI\User\globalStorage\credentials.json`,
     `%APPDATA%\AbacusAI Code Mode\User\globalStorage\credentials.json`,
     `%USERPROFILE%\.abacusai\credentials.json`, `%USERPROFILE%\.abacusai\config.json`
   - **macOS**: `~/Library/Application Support/AbacusAI/...`, `~/.abacusai/...`
   - **Linux**: `~/.config/AbacusAI/...`, `~/.abacusai/...`
   - Accepts fields: `apiKey`, `api_key`, `token`, `accessToken`, `access_token`
2. **Environment variable** — `ABACUSAI_API_KEY`
3. **Manual entry** — interactive prompt

### During Auto-Start (gateway startup / before agent call)

1. **OpenClaw auth profiles** — searches `~/.openclaw/agents/*/agent/auth-profiles.json`
   for any profile with ID starting with `abacusai:`. Accepts both `token` and `key`
   credential fields.
2. **Legacy root-level** — `~/.openclaw/auth-profiles.json` (fallback for future layout changes)
3. **Environment variable** — `ABACUSAI_API_KEY`
4. **Local Code Mode credentials** — same platform-specific scan as login

---

## Embedded RouteLLM Proxy

The proxy is a lightweight Node.js HTTP server (`node:http`) that binds to
`127.0.0.1` on a dynamically assigned port (OS-allocated via `listen(0)`).

### Request Pipeline

For every incoming request:

1. **CORS headers** are set (`Access-Control-Allow-Origin: *`).
2. **OPTIONS** requests receive an immediate `204 No Content`.
3. The URL path is rewritten: leading `/v1` is stripped (since the upstream
   `ROUTELLM_BASE` already includes `/v1`).
4. The **Authorization header** is injected: `Bearer <api-key>`.
5. For **POST** requests, the JSON body is parsed and:
   - The `strict` field is **stripped** from all `tools[].function` schemas
     (RouteLLM rejects this OpenAI-specific field).
6. The request is forwarded to `https://routellm.abacus.ai/v1/...` with a
   **180-second timeout** (`AbortSignal.timeout`).
7. **401/403 responses** are intercepted and returned as `auth_expired` errors
   with a clear message guiding the user to re-authenticate.
8. **SSE streaming responses** (`text/event-stream`) are piped through the
   SSE normalizer (see below).
9. **Non-streaming JSON responses** have their `finish_reason` normalized and
   `native_finish_reason` stripped.

### SSE Streaming Normalizer

AbacusAI's RouteLLM endpoint has a non-standard SSE streaming behavior:

- **Standard SSE**: `data: {...}\n\ndata: {...}\n\n` (double-newline delimited)
- **RouteLLM actual behavior**: each `data: {...}` may arrive as a separate TCP
  chunk with **no trailing newlines** between them.

Line-based SSE parsers break on this because they never see the expected `\n\n`
delimiter. The plugin implements a **JSON brace-matching normalizer**:

1. Incoming TCP chunks are appended to an internal buffer.
2. The buffer is scanned for `data: ` prefixes.
3. After each prefix, a **brace-depth counter** tracks `{` and `}` characters
   (respecting string literals and escape sequences) to find the end of each
   complete JSON object.
4. Complete events are emitted as properly framed SSE: `data: {...}\n\n`.
5. Incomplete JSON remains in the buffer until the next chunk arrives.
6. On stream end, `flush()` emits any remaining buffered content.

This approach is robust against arbitrary TCP fragmentation patterns.

### finish_reason Normalization

RouteLLM returns **Anthropic-style** `finish_reason` values for Claude models,
which the OpenClaw Agent does not recognize:

| RouteLLM Value  | Normalized (OpenAI) | Meaning                   |
| --------------- | ------------------- | ------------------------- |
| `tool_use`      | `tool_calls`        | Model wants to call tools |
| `stop_sequence` | `stop`              | Stop sequence hit         |
| `end_turn`      | `stop`              | Natural end of response   |

Additionally, RouteLLM includes a non-standard `native_finish_reason` field in
each choice object, which is **stripped** to avoid confusing downstream consumers.

This normalization is applied to both streaming SSE chunks and non-streaming
JSON responses.

---

## Proxy Lifecycle

### Auto-Start on Gateway Launch

When the gateway starts and loads plugins, the `register()` method checks if the
AbacusAI provider is configured with a local proxy URL (`127.0.0.1` in `baseUrl`).
If so, it **immediately** starts the proxy asynchronously (fire-and-forget) without
blocking plugin registration.

The startup sequence:

1. Recover API key from saved auth profiles
2. Validate the key against `https://api.abacus.ai/api/v0/describeUser` (15s timeout)
3. Start the HTTP server on a dynamic port (10s timeout)
4. Update `openclaw.json` with the real `baseUrl` (e.g., `http://127.0.0.1:54382/v1`)

### Idle Timeout

The proxy automatically shuts down after **30 minutes** of inactivity
(`PROXY_IDLE_TIMEOUT_MS`). Every incoming request resets the idle timer.
When the timer fires, the server is gracefully closed with
`closeAllConnections()` to prevent process hangs.

### before_agent_start Safety Net

A `before_agent_start` hook is registered as a safety net. Before each agent
invocation, it checks if the proxy is still running and restarts it if needed.
This handles cases where:

- The proxy was stopped by idle timeout
- The proxy crashed due to an unexpected error
- The gateway was started without the plugin initially configured

---

## Defensive Programming

The proxy implements several defensive measures:

### Process Residue Prevention

- `stopProxy()` is asynchronous and calls `closeAllConnections()` to force-close
  all active HTTP connections before closing the server.
- A **2-second safety timeout** ensures `stopProxy()` always resolves, even if
  the `server.close()` callback never fires.
- `ensureProxy()` checks `server.listening` (not just `server !== null`) to detect
  stale servers that exist but stopped listening.
- Stale servers are cleaned up before starting a new one.

### API Key Expiration Handling

- **At startup**: `ensureProxy()` validates the API key via `describeUser` before
  starting the proxy. If validation fails, a clear error is logged:
  ```
  [abacusai] API key validation failed: Invalid API key.
  Run `openclaw models auth login --provider abacusai` to re-authenticate.
  ```
- **At runtime**: `handleProxyRequest()` detects 401/403 responses from upstream
  and returns a structured `auth_expired` error:
  ```json
  {
    "error": {
      "message": "AbacusAI API key expired or invalid (HTTP 401). Run `openclaw models auth login --provider abacusai` to re-authenticate.",
      "type": "auth_expired"
    }
  }
  ```

### Startup Timeout

`startProxy()` is raced against a **10-second timeout** (`PROXY_START_TIMEOUT_MS`)
via `Promise.race`. If `server.listen()` hangs (e.g., due to OS-level issues),
the startup fails cleanly instead of blocking indefinitely. Any partially started
server is cleaned up.

### Request Body Size Limit

`readBody()` enforces a **10 MB limit** (`MAX_BODY_BYTES`). If a request body
exceeds this, the request stream is destroyed immediately to prevent memory
exhaustion. This is a safety measure even though the proxy only listens on
localhost.

### Upstream Request Timeout

All requests forwarded to RouteLLM have a **180-second timeout**
(`AbortSignal.timeout(180_000)`). This prevents the proxy from hanging
indefinitely on slow or unresponsive upstream connections.

---

## Configuration Reference

After login, the plugin writes the following to `~/.openclaw/openclaw.json`:

```jsonc
{
  "models": {
    "providers": {
      "abacusai": {
        "baseUrl": "http://127.0.0.1:<port>/v1", // dynamic, updated on proxy start
        "apiKey": "abacusai-proxy", // dummy — real key is in the proxy
        "api": "openai-completions",
        "authHeader": false, // proxy handles auth
        "models": [
          {
            "id": "claude-opus-4-6",
            "name": "claude-opus-4-6",
            "api": "openai-completions",
            "reasoning": false,
            "input": ["text", "image"],
            "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
            "contextWindow": 200000,
            "maxTokens": 8192,
          },
          // ... other models
        ],
      },
    },
  },
}
```

Credentials are stored separately in `~/.openclaw/agents/<agent>/agent/auth-profiles.json`:

```jsonc
{
  "profiles": {
    "abacusai:<email-or-default>": {
      "type": "token",
      "provider": "abacusai",
      "token": "<api-key>",
    },
  },
}
```

### Environment Variables

| Variable             | Description                                                    |
| -------------------- | -------------------------------------------------------------- |
| `ABACUSAI_API_KEY`   | API key fallback (used if no saved profile is found)           |
| `OPENCLAW_STATE_DIR` | Override the OpenClaw state directory (default: `~/.openclaw`) |

---

## Troubleshooting

### Proxy not starting with gateway

Check the gateway logs for `[abacusai]` prefixed messages. Common causes:

- **No API key found**: Run `openclaw models auth login --provider abacusai`
- **API key expired**: Re-authenticate with the same command
- **Plugin disabled**: Run `openclaw plugins enable abacusai-auth`

### "Unhandled stop reason: tool_use"

This error means `finish_reason` normalization is not working. Ensure you are
running the latest build with the RouteLLM proxy. The proxy normalizes
`tool_use` → `tool_calls` automatically.

### Port conflict

The proxy uses `listen(0)` for OS-assigned dynamic ports, so port conflicts
should not occur. If you see `EADDRINUSE`, it means a stale server was not
cleaned up — restart the gateway to resolve.

### Connection refused

The proxy may have been stopped by the 30-minute idle timeout. Send any request
to trigger the `before_agent_start` hook, which will restart it automatically.

### API key validation failed

Your API key may have been revoked or expired. Generate a new one at
<https://abacus.ai/app/profile/apikey> and re-authenticate:

```bash
openclaw models auth login --provider abacusai --set-default
```

---

## Getting an API Key

1. Sign in at <https://abacus.ai>
2. Navigate to **Profile → API Keys** (<https://abacus.ai/app/profile/apikey>)
3. Click **Generate new API Key**
4. Copy the key (starts with `s2_...`)

---

## File Structure

```
extensions/abacusai-auth/
├── index.ts        # Plugin source (proxy, auth, normalization)
├── package.json    # Package metadata
└── README.md       # This file
```

## Key Constants

| Constant                 | Value                           | Description                            |
| ------------------------ | ------------------------------- | -------------------------------------- |
| `ROUTELLM_BASE`          | `https://routellm.abacus.ai/v1` | Upstream RouteLLM endpoint             |
| `ABACUS_API`             | `https://api.abacus.ai/api/v0`  | AbacusAI REST API (for key validation) |
| `PROXY_IDLE_TIMEOUT_MS`  | 30 min                          | Auto-shutdown after inactivity         |
| `PROXY_START_TIMEOUT_MS` | 10 s                            | Max time to wait for proxy startup     |
| `MAX_BODY_BYTES`         | 10 MB                           | Request body size limit                |
| `DEFAULT_CONTEXT_WINDOW` | 200,000                         | Default context window for all models  |
| `DEFAULT_MAX_TOKENS`     | 8,192                           | Default max output tokens              |
