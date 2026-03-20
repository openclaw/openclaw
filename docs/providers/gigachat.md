---
summary: "Use GigaChat in OpenClaw, including auth modes, host selection, streaming/tool-calling behavior, and current limits"
read_when:
  - You want to set up GigaChat in OpenClaw
  - You are debugging GigaChat auth, host selection, or tool calling
  - You need the current GigaChat capability boundary
title: "GigaChat"
---

# GigaChat

OpenClaw ships a GigaChat provider with **GigaChat 2 Max** as the default model ref:
`gigachat/GigaChat-2-Max`.

OpenClaw currently keeps GigaChat **text-only** even though the upstream model can be multimodal.
Image and PDF analysis stay disabled until the provider path supports multimodal requests end to end.

## Choose a setup

### Personal OAuth - recommended

**Best for:** the normal hosted GigaChat OAuth flow with a credentials key from Sber Developer Studio.

Run interactive onboarding:

```bash
openclaw onboard
```

Then choose:

1. **GigaChat**
2. **Personal**
3. **OAuth**

For non-interactive onboarding, use either of these forms:

```bash
openclaw onboard --non-interactive --auth-choice gigachat-api-key --gigachat-api-key "$GIGACHAT_CREDENTIALS"
```

```bash
openclaw onboard --non-interactive --auth-choice apiKey --token-provider gigachat --token "$GIGACHAT_CREDENTIALS"
```

Notes:

- Both commands configure the same personal OAuth path.
- If `GIGACHAT_CREDENTIALS` is already exported, the non-interactive path can resolve it from the environment.
- The personal OAuth path expects a real credentials key, not `user:password`.

### Business OAuth

**Best for:** hosted GigaChat business accounts.

Business OAuth is currently an **interactive-only** flow. Run:

```bash
openclaw onboard
```

Then choose:

1. **GigaChat**
2. **Business**
3. **OAuth**

OpenClaw will prompt for the business scope:

- `GIGACHAT_API_B2B` - prepaid
- `GIGACHAT_API_CORP` - postpaid

### Basic auth

**Best for:** username/password setups, custom hosts, or controlled/private deployments.

Basic auth is also **interactive-only**. Run:

```bash
openclaw onboard
```

Then choose:

1. **GigaChat**
2. **Personal** or **Business**
3. **Basic auth**

Interactive Basic auth can prefill values from:

- `GIGACHAT_BASE_URL`
- `GIGACHAT_USER`
- `GIGACHAT_PASSWORD`

The stock Basic host is:

- `https://gigachat.ift.sberdevices.ru/v1`

## Implicit provider resolution

OpenClaw can inject a GigaChat provider automatically when it finds:

- a stored `gigachat:default` auth profile, or
- `GIGACHAT_CREDENTIALS` in the environment

That means a minimal config can be as small as:

```json5
{
  env: { GIGACHAT_CREDENTIALS: "your-credentials-key" },
  agents: { defaults: { model: { primary: "gigachat/GigaChat-2-Max" } } },
}
```

For implicit setups:

- `GIGACHAT_BASE_URL` overrides the inferred host
- OAuth credentials default to `https://gigachat.devices.sberbank.ru/api/v1`
- Basic `user:password` credentials default to `https://gigachat.ift.sberdevices.ru/v1`

## Configuration

- `models.providers.gigachat.baseUrl`: explicit GigaChat API base URL.
- `models.providers.gigachat.api`: `openai-completions`.
- `models.providers.gigachat.models`: the GigaChat catalog OpenClaw should expose.
- `agents.defaults.model.primary`: usually `gigachat/GigaChat-2-Max`.
- `GIGACHAT_CREDENTIALS`: GigaChat credentials key for OAuth, or Basic credentials in `user:password` form for implicit/manual Basic setups.
- `GIGACHAT_BASE_URL`: host override for implicit GigaChat provider resolution.
- `GIGACHAT_USER`: interactive Basic username default.
- `GIGACHAT_PASSWORD`: interactive Basic password default.
- `GIGACHAT_VERIFY_SSL_CERTS=false`: disables TLS certificate verification for the GigaChat SDK transport. Only use this in trusted environments.
- `GIGACHAT_DISABLE_FUNCTIONS=1`: disables GigaChat tool calling.

## Architecture Notes

### Auth resolution

OpenClaw stores GigaChat auth mode in auth-profile metadata as either `oauth` or `basic`.
When that metadata is missing, it only falls back to shape-based inference for the obvious
single-colon `user:password` form.

That narrow fallback is intentional:

- `user:password` is treated as Basic
- OAuth credentials keys that happen to contain additional `:` characters stay OAuth

The OAuth onboarding paths reject Basic-shaped `GIGACHAT_CREDENTIALS` values on purpose so
OpenClaw does not silently reuse Basic credentials and then rewrite the provider to the OAuth
endpoint.

### Base URL ownership

OpenClaw treats host selection differently for explicit and implicit setups:

- explicit `models.providers.gigachat.baseUrl` wins over environment defaults
- `GIGACHAT_BASE_URL` is mainly for implicit env/profile-backed provider injection

On re-auth:

- re-running OAuth onboarding preserves an existing custom OAuth host
- switching a stored Basic setup back to OAuth resets the provider to the stock OAuth host instead of carrying a stale Basic host forward

### Streaming and tool calls

The GigaChat stream implementation is shaped around a few provider quirks:

- SSE parsing uses a streaming UTF-8 `TextDecoder`, so multibyte text survives chunk boundaries.
- OpenClaw strips leaked `assistant function call...{` prefixes before saving assistant text.
- Multiple streamed function calls in a single assistant turn are preserved in order.
- Tool schemas are cleaned for GigaChat compatibility before the request is sent:
  nested objects become JSON-string fields, unsupported JSON Schema features are dropped, and tool names are normalized to alphanumeric + underscore form.
- After the stream finishes, OpenClaw rehydrates nested tool arguments back into objects and arrays before emitting the final `toolCall`.
- Valid JSON object tool results stay object-shaped; non-object tool results are wrapped as `{"result": ...}` for GigaChat compatibility.
- The runtime caches the SDK client and access token, refreshes only when needed, and retries once after a `401`.
- Custom request headers and payload hooks are forwarded to the final `/chat/completions` request.

### Current capability boundary

OpenClaw currently advertises GigaChat 2 Max as:

- `input: ["text"]`

That is deliberate. Even though the upstream model can be multimodal, OpenClaw does not enable
image attachments or image-only PDF analysis for GigaChat until the provider path supports that
behavior end to end.

## Troubleshooting

### OAuth onboarding rejects my credential

If the value looks like `user:password`, OpenClaw treats it as Basic credentials, not an OAuth
credentials key. Use the interactive **Basic auth** flow instead, or replace `GIGACHAT_CREDENTIALS`
with a real OAuth credentials key and retry.

### I switched from Basic to OAuth and still hit the wrong host

Re-run onboarding through the OAuth path. OpenClaw resets stored Basic hosts back to the stock
OAuth host during that migration so later requests do not keep targeting the old Basic endpoint.

### Why are image or PDF inputs unavailable?

That is the current supported behavior. OpenClaw keeps GigaChat text-only for now, so image/PDF
analysis remains disabled until multimodal support is implemented end to end.

## See also

- [Model providers](/concepts/model-providers)
- [Streaming + chunking](/concepts/streaming)
- [Provider directory](/providers/index)
