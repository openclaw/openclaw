---
summary: "Connect Liquid AI d1 and d1 Ultra as native Decision models"
title: "Liquid AI"
read_when:
  - Configuring native Liquid AI credentials
  - Selecting d1 or d1 Ultra for typed decisions
---

# Liquid AI

[Liquid AI's Decision models](https://docs.liquid.ai/lfm/models/d1) return
Boolean probabilities, choices, and rubric scores from text, JSON, or images.
OpenClaw connects directly to Liquid's native API. No OpenRouter account or
TypeSafe credential is required.

The `liquid-ai` plugin is an unpublished candidate. These instructions require a
development checkout containing this plugin and the Decision V2 contract;
the package metadata alone does not mean it is available on npm or ClawHub.

## Set up the provider

From that checkout, install the local plugin and restart the Gateway:

```bash
pnpm openclaw plugins install ./extensions/liquid-ai
pnpm openclaw gateway restart
pnpm openclaw models auth login --provider liquid-ai --method api-key
```

Enter your Liquid AI API key in the protected prompt. The provider also recognizes
`LIQUIDAI_API_KEY` in the Gateway environment and normal provider auth profiles.
Connecting Liquid stores credentials only: it does not select a chat model or
replace an existing primary or utility model.

Liquid AI is separate from [Liquid Inference](/providers/liquid-inference).
The `liquid-ai` provider uses only its own auth profiles and `LIQUIDAI_API_KEY`;
it does not use the exchange's `liquid` provider or `LIQUID_API_KEY`.

Select a [Decision model](/concepts/decision-models):

```json5
{
  agents: {
    defaults: { decisionModel: "liquid-ai/d1-ultra" },
  },
}
```

Both `liquid-ai/d1` and `liquid-ai/d1-ultra` appear in the Decision picker. They are
not chat models. The manifest declares their native capabilities without
inventing a chat API, context window, output-token limit, or model-list endpoint.

## Evaluate a decision

Use the core `decision_evaluate` tool with `contractVersion: 2`, or call
`api.runtime.decisions.evaluateV2` from an owned plugin operation:

```json
{
  "contractVersion": 2,
  "state": { "type": "text", "text": "Checkout is failing for all customers." },
  "questions": {
    "escalate": { "type": "boolean", "instructions": "Does this need incident response?" },
    "route": {
      "type": "choice",
      "criteria": { "support": "Service failures", "billing": "Payment questions" }
    },
    "urgency": {
      "type": "score",
      "criteria": ["No disruption", "One workflow blocked", "Widespread outage"]
    }
  }
}
```

State accepts text, JSON objects or arrays, or one inline PNG, JPEG, or WebP
image with optional text. Choice and Score support at least two alternatives;
their instructions and criterion descriptions may be null or omitted where the
question contract allows it. Boolean questions need instructions or at least one
non-null true/false criterion. Box, sorting, and tags are not supported. Omit
reasoning or use `auto`; explicit on/off reasoning is not supported.
Configured generation or routing parameters, including inherited agent defaults,
are rejected instead of silently discarded. The native endpoint has no chat
parameter contract.

OpenClaw preserves the native Boolean probability, selected label, fractional
score, confidence, and rounded distributions. It does not normalize estimates
or derive a score from the returned probabilities. Missing actual cost remains
missing. Liquid reports input usage and zero output tokens; the adapter does
not manufacture a bill from catalog pricing.

## Limits and routing

The complete UTF-8 JSON request, including base64 image data, state, and
questions, must be smaller than 4,500,000 bytes. The host also limits decoded
images to 4 MiB and text/JSON evidence to its normal Decision bounds. An image
must use at most 10,000 patches, calculated as
`ceil(width / 32) * ceil(height / 32)`, with an aspect ratio no greater than
100:1. OpenClaw checks dimensions before sending; it never fetches remote image
URLs, resizes evidence, or silently splits a batch. The JSON-body bound can reject
an image that fits the decoded-image bound.

Evaluations send supplied evidence to
`https://api.liquid.ai/decisions/v1/systemone` and incur Liquid usage charges.
Standard prepared auth/header overrides, proxy, TLS, and private-network controls
apply. Decision support is tied to provider-declared compatible routes. Changing
`models.providers["liquid-ai"].baseUrl` to an undeclared endpoint does not grant that
endpoint native Decision capabilities. A declared route keeps its path prefix
and receives `/systemone`. There is no fallback to a chat endpoint or another account.

See [Liquid's hosted API contract](https://docs.liquid.ai/lfm/models/d1) and
[d1 Ultra announcement](https://www.liquid.ai/blog/d1-ultra) for current model
availability, billing, and upstream limits.
