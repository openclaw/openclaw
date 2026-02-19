---
summary: "Use Edgee AI Gateway models in OpenClaw"
read_when:
  - You want to use Edgee as a model provider
  - You need an OpenAI-compatible gateway with model routing
title: "Edgee"
---

# Edgee

**Edgee** is an OpenAI-compatible AI Gateway that gives access to many upstream providers through one API key and endpoint.

## Why use Edgee in OpenClaw

- OpenAI-compatible API (`/v1`)
- Single API key (`EDGEE_API_KEY`)
- Model IDs in `provider/model` format (for example `openai/gpt-4o`)
- Automatic token compression (transparent)
- Gateway routing/fallbacks handled on the Edgee side

## Endpoint and auth

- Base URL: `https://api.edgee.ai/v1`
- Auth: Bearer token in `Authorization: Bearer <token>`

## Setup

### Option A — Environment variable

```bash
export EDGEE_API_KEY="your_edgee_api_key"
```

### Option B — Onboarding flow

```bash
openclaw onboard --auth-choice edgee-api-key
```

### Option C — Non-interactive

```bash
openclaw onboard --non-interactive \
  --auth-choice edgee-api-key \
  --edgee-api-key "your_edgee_api_key"
```

## Default model

OpenClaw sets this default model for Edgee:

- `edgee/openai/gpt-4o`

You can change it anytime:

```bash
openclaw models set edgee/anthropic/claude-sonnet-4-20250514
```

## Verify

```bash
openclaw chat --model edgee/openai/gpt-4o "Hello from Edgee"
```

## Notes

- Edgee model IDs are passed through as provider-prefixed IDs.
- Token compression is automatic and does not require OpenClaw-side configuration.
- See official docs: <https://www.edgee.ai/docs>
