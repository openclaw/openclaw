---
summary: "Connect Drex Max v1.1 as a native Decision model"
title: "Nace"
read_when:
  - Configuring Nace credentials for native decisions
  - Selecting Drex Max v1.1 for typed decisions
---

# Nace

Drex Max v1.1 answers typed questions with probabilities instead of
generating chat text. OpenClaw uses its native OpenAI Decisions-compatible endpoint:

```text
POST https://console.nace.ai/v1/decisions
```

The `nace` plugin is an unpublished candidate. These instructions require a
development checkout containing this plugin and the Decision V2 contract;
package metadata alone does not mean it is available on npm or ClawHub.

## Setup

From that checkout, install the local plugin and restart the Gateway:

```bash
pnpm openclaw plugins install ./extensions/nace
pnpm openclaw gateway restart
pnpm openclaw models auth login --provider nace --method api-key
```

Enter your Nace API key in the protected prompt. The provider also recognizes
`NACE_API_KEY` in the Gateway environment and normal provider auth profiles.
Connecting stores credentials only: it does not replace your primary chat model
or select a Decision model.

Select the [Decision model](/concepts/decision-models) explicitly:

```json5
{
  agents: {
    defaults: { decisionModel: "nace/drex-max-v1.1" },
  },
}
```

## Supported decisions

Use `decision_evaluate` with `contractVersion: 2`, or an owned plugin operation
calling `api.runtime.decisions.evaluateV2`. Text and JSON evidence are supported.
JSON is serialized as text in the API's `input` field.

- Boolean questions return the native probability of true.
- Choice questions return the selected label and all option probabilities.
- Score questions return the native fractional, probability-weighted level and
  its distribution, not a rounded winning level.

OpenClaw preserves reported confidence and token usage. It does not normalize
probabilities, recompute scores, or estimate a bill. Confidence is provider-specific;
it is not necessarily the selected option's probability. Missing actual cost stays
missing.

Image input is **not yet exposed** by this adapter, even though the upstream model
supports images. Images, stable-ID lists, sorting, tags, and box questions are
rejected before HTTP. Omit reasoning or use `auto`; explicit `on`/`off` is not
supported. There is no chat-completions fallback.

## Limits and routing

Drex Max v1.1 documents 512 questions, but this adapter uses the shared OpenAI
Decisions transport's conservative limit of 400. Choice and Score questions
accept 2–255 options or levels. Its 262,144-token limit covers the **whole packed
request**: state, all questions, formatting, and decision markers. It is not a
per-question budget. The upstream serialized-body limit is 4 MiB. The provider
rejects oversized requests; OpenClaw does not truncate or split the evidence.

The selected model is pinned to `drex-max-v1.1`; this adapter does not substitute
`drex-latest` or retired aliases. Nace documents that model availability can vary
by environment and API key. A catalog entry does not establish access.

The default base URL is `https://console.nace.ai/v1`.
Normal provider base-URL and prepared request-header overrides apply; the transport
appends `/decisions`. Use only a compatible endpoint you control and credentials
intended for it.

Sources: [OpenAI Decisions API](https://console.nace.ai/docs/drex/api-reference/decisions),
[Drex Max](https://console.nace.ai/docs/drex/guides/drex-max), and
[request limits](https://console.nace.ai/docs/drex/reference/limits).
