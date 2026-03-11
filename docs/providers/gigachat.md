---
summary: "Use Sber GigaChat models in OpenClaw"
read_when:
  - You want to use GigaChat (Sber) with OpenClaw
  - You need a Russian-language LLM
  - You are a Sber Studio user
title: "GigaChat"
---

# GigaChat Provider Guide

GigaChat is Sber's large language model platform. It provides a family of Russian-language
models (GigaChat, GigaChat-Plus, GigaChat-Pro, GigaChat-Max) through an API that is broadly
compatible with the OpenAI Chat Completions format.

## Prerequisites

1. A [Sber Studio](https://developers.sber.ru/studio) account
2. A created project / application with GigaChat API access
3. Your **Client ID** and **Client Secret** from the project settings

## Authentication

GigaChat uses OAuth 2.0. Your credentials (`ClientId:ClientSecret`) must be provided to
OpenClaw as a Base64-encoded string — this matches the format Sber Studio shows as
"Authorization data".

```bash
# Encode your credentials (macOS / Linux)
echo -n "your-client-id:your-client-secret" | base64
# → e.g. dGVzdC1jbGllbnQtaWQ6dGVzdC1zZWNyZXQ=
```

Set the result as `GIGACHAT_CREDENTIALS` in your environment:

```bash
export GIGACHAT_CREDENTIALS="dGVzdC1jbGllbnQtaWQ6dGVzdC1zZWNyZXQ="
```

OpenClaw will exchange these credentials for a Bearer token automatically and refresh it
before it expires (tokens are valid for ~30 minutes).

> **Alternative – pre-obtained access token**
>
> If you already have an access token (e.g. from a CI pipeline), set it as `GIGACHAT_API_KEY`.
> Note that this token expires in ~30 minutes and OpenClaw will not refresh it automatically.

## CLI Setup

```bash
export GIGACHAT_CREDENTIALS="<your-base64-credentials>"
openclaw models set gigachat/GigaChat-Max
```

Or add it to your `openclaw.json`:

```json5
{
  "env": {
    "GIGACHAT_CREDENTIALS": "your-base64-credentials"
  },
  "agents": {
    "defaults": {
      "model": {
        "primary": "gigachat/GigaChat-Max"
      }
    }
  }
}
```

## Available Models

| Model ID | Context | Notes |
|---|---|---|
| `gigachat/GigaChat` | 32 K | Lightweight, fast |
| `gigachat/GigaChat-Plus` | 32 K | Balanced |
| `gigachat/GigaChat-Pro` | 128 K | Extended context |
| `gigachat/GigaChat-Max` | 128 K | Most capable, supports reasoning |

## Scope

GigaChat API access is split into scopes:

| Scope | Description |
|---|---|
| `GIGACHAT_API_PERS` | Personal account (default) |
| `GIGACHAT_API_B2B` | Business account |
| `GIGACHAT_API_CORP` | Corporate account |

The default scope is `GIGACHAT_API_PERS`. To use a different scope, set `GIGACHAT_SCOPE`:

```bash
export GIGACHAT_SCOPE="GIGACHAT_API_B2B"
```

## Known Limitations

### No tool / function calling

GigaChat uses a legacy `functions` / `function_call` schema that is incompatible with
OpenAI's `tools` array format. OpenClaw's built-in tool-use path (file access, web search,
code execution, etc.) is therefore **not available** with this provider.

Use GigaChat for conversational tasks, text generation, and summarisation. If you need
tool-use, switch to an OpenAI, Anthropic, or compatible model.

### Parameter types in function schemas

When using GigaChat's function-calling API directly (outside OpenClaw), only `string`
and `object` property types are reliably supported. `integer`, `number`, `boolean`, and
`array` types may not be validated correctly on the GigaChat side.

### SSL verification

GigaChat's production endpoint uses a Sber-issued certificate that may not be trusted
by the default system CA bundle outside Russia. If you encounter SSL errors, you may need
to:
1. Install the Sber root CA certificate, **or**
2. Set `GIGACHAT_VERIFY_SSL=false` (not recommended for production)

### System message placement

GigaChat requires the `system` role message to appear only as the **first message** in
the conversation history. OpenClaw handles this automatically.

## Related Documentation

- [GigaChat API Reference](https://developers.sber.ru/docs/ru/gigachat/api/overview)
- [Sber Studio](https://developers.sber.ru/studio)
- [OpenClaw Model Providers](/concepts/model-providers)
- [OpenClaw Configuration](/gateway/configuration)
