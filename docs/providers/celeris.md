---
summary: "Connect Celeris-1.1 Decision as a native Decision model"
title: "Celeris"
read_when:
  - Configuring Celeris credentials for native decisions
  - Selecting Celeris-1.1 Decision for typed decisions
---

# Celeris

Celeris-1.1 Decision answers typed questions with probabilities instead of
generating chat text. OpenClaw uses its native OpenAI Decisions-compatible endpoint:

```text
POST https://inference.celeris.ai/celeris-1-decision/v1/decisions
```

The `celeris` plugin is an unpublished candidate. These instructions require a
development checkout containing this plugin and the Decision V2 contract;
package metadata alone does not mean it is available on npm or ClawHub.

## Setup

From that checkout, install the local plugin and restart the Gateway:

```bash
pnpm openclaw plugins install ./extensions/celeris
pnpm openclaw gateway restart
pnpm openclaw models auth login --provider celeris --method api-key
```

Enter your Celeris API key in the protected prompt. The provider also recognizes
`CELERIS_API_KEY` in the Gateway environment and normal provider auth profiles.
Connecting stores credentials only: it does not replace your primary chat model
or select a Decision model.

Select the [Decision model](/concepts/decision-models) explicitly:

```json5
{
  agents: {
    defaults: { decisionModel: "celeris/celeris-1.1-decision" },
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

Celeris documents 512 questions and 512 choice options, but this adapter uses the
shared OpenAI Decisions transport's conservative limits of 400 questions and
255 choices. Score questions accept 2–64 levels. The advertised context ceiling
is 131,072 tokens; Celeris reserves some of that space for answers, so the usable
input limit is lower. The upstream body limit is 8 MiB. The provider rejects
oversized requests; OpenClaw does not truncate or split the evidence.

The model's URL path is `celeris-1-decision`, even though its request model is
`celeris-1.1-decision`. Explanations and other `x_celeris` extensions are not
exposed by this adapter.

The default base URL is `https://inference.celeris.ai/celeris-1-decision/v1`.
Normal provider base-URL and prepared request-header overrides apply; the transport
appends `/decisions`. Use only a compatible endpoint you control and credentials
intended for it.

Sources: [Decisions API](https://docs.celeris.ai/decisions.md) and
[model routing and context](https://docs.celeris.ai/models.md).
