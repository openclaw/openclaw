---
summary: "Connect OpenClaw to a Bifrost OpenAI-compatible model gateway"
title: "Bifrost"
read_when:
  - You want to route OpenClaw through a Bifrost gateway
---

[Bifrost](https://getbifrost.ai) routes requests to upstream models through an
OpenAI-compatible gateway. The bundled plugin connects to an existing gateway;
it does not install Bifrost or manage its upstream credentials.

## Setup

```bash
openclaw onboard --auth-choice bifrost-api-key
```

Enter the gateway URL (default `http://localhost:8080/openai/v1`), choose whether
it needs a virtual key, and select a model advertised by `/models`. If discovery
is unavailable, setup explains the next step and accepts a model ID manually.
Discovered model metadata, including the reported context window, is retained.

For non-interactive setup with a modern Bifrost virtual key:

```bash
openclaw onboard --non-interactive --accept-risk \
  --auth-choice bifrost-api-key \
  --custom-base-url http://localhost:8080/openai/v1 \
  --bifrost-api-key "$BIFROST_VIRTUAL_KEY" \
  --custom-model-id ollama/qwen3:4b
```

For a gateway configured to allow anonymous inference, replace the key flag with
`--custom-no-auth`. Setup stores `auth: "none"` and creates no credential profile.
Without `--custom-model-id`, non-interactive setup selects the first discovered
model. If no model is found, pass an explicit model ID or check the gateway.

Re-running setup replaces the provider's authentication settings, including
previous custom authentication headers. Configure advanced request headers after
setup. Authored models are retained when reconnecting to the same endpoint.

## Endpoint and model IDs

Use Bifrost's OpenAI-compatible base, normally
`http://localhost:8080/openai/v1`. A base ending in `/openai` is also accepted;
setup normalizes it to `/openai/v1` so discovery and inference use the same base.
The URL must use HTTP or HTTPS. Non-interactive setup reports an invalid gateway
URL and exits with status 1 without saving credentials or configuration.

Keep Bifrost's provider-qualified model IDs intact. For example, a gateway model
named `ollama/qwen3:4b` becomes the OpenClaw reference
`bifrost/ollama/qwen3:4b`. IDs with additional slashes are supported.

```bash
openclaw models list --provider bifrost --refresh --json
openclaw models set bifrost/ollama/qwen3:4b
```

Catalog refresh uses the shared OpenAI-compatible discovery owner. As with other
providers, `models.mode: "replace"` keeps the explicitly configured catalog.

## Authentication

Standard setup sends a virtual key beginning with `sk-bf-` as
`Authorization: Bearer`. Bifrost supports these virtual keys when inference
virtual-key enforcement is enabled; dashboard authentication is a separate
concern. The gateway decides which models the key may access.

Older virtual keys without the `sk-bf-` prefix require Bifrost's `x-bf-vk`
header and are outside the standard API-key setup. Use the existing
[provider request configuration](/gateway/configuration-reference#models) for
such deployment-specific headers and verify the gateway accepts them.

With explicit `auth: "none"`, OpenClaw does not fall back to an environment or
saved-profile bearer credential. Use this only for a gateway that allows
anonymous inference.
