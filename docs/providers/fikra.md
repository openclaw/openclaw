---
summary: "Fikra API setup (OpenAI-compatible, pinned DeepSeek builds)"
title: "Fikra API"
read_when:
  - You want to use Fikra API with OpenClaw
  - You need the base URL, API key env var or model IDs
---

Fikra API is an OpenAI-compatible inference endpoint with pinned DeepSeek builds.

| Property | Value                           |
| -------- | ------------------------------- |
| Provider | `fikra`                         |
| Auth     | `FIKRA_API_KEY`                 |
| API      | OpenAI-compatible               |
| Base URL | `https://api.fikraapi.co.ke/v1` |

## Models

- `deepseek-v4.1-flash-1017`
- `deepseek-v4.1-flash`
- `deepseek-v4-flash-0731`

Read the live limits from [`GET /v1/models`](https://api.fikraapi.co.ke/v1/models). The 1017 build currently exposes 1,048,576 context and 393,216 max output.

## Setup

Use the custom OpenAI-compatible provider path in OpenClaw. Set the base URL to `https://api.fikraapi.co.ke/v1`, store the key as `FIKRA_API_KEY`, and select a model with the `fikra/` prefix.

If your build requires a provider plugin, install the OpenAI-compatible provider plugin and point it at the same base URL.

## Agent accounts

An agent can create a provisional account for a human with `POST https://api.fikraapi.co.ke/v1/agents/accounts`, get a 6-hour delegated token, create a key and top up. See the [agent guide](https://fikraapi.co.ke/for-agents).
