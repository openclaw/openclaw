---
summary: "Connect Fastino GLiDE to the separate Decision model role"
title: "Fastino"
read_when:
  - Configuring Fastino credentials
  - Using GLiDE Boolean probabilities, choices, or rubric scores
---

# Fastino

The `fastino` plugin connects to [Fastino's native GLiDE API](https://docs.fastino.ai/inference/systemone).
It is a development-checkout candidate, not a claim that its package is published.
Install from a checkout containing this plugin and the prepared Decision V2 contract:

```bash
pnpm openclaw plugins install ./extensions/fastino
pnpm openclaw models auth login --provider fastino --method api-key
```

Enter the API key in the protected prompt, or provide `FASTINO_API_KEY` to the
Gateway process. Connecting credentials does not change any model selection.
Choose `fastino/fastino/GLiDE` in the **Decision** picker or merge this role setting:

```json5
{
  agents: { defaults: { decisionModel: "fastino/fastino/GLiDE" } },
}
```

The repeated prefix is intentional: `fastino` is the OpenClaw provider and
`fastino/GLiDE` is the [documented hosted model selector](https://docs.fastino.ai/inference/systemone).
The server reports `glide`. That unversioned selector is **not a verified pin** to
the GLiDE v1.2 checkpoint in Artificial Analysis's evaluation.

## Supported decisions

Calls use `POST https://api.fastino.ai/v1/systemone`, with Boolean, Choice, and
Score questions. Text is sent directly; JSON evidence and non-text rubric entries
are serialized as text, not interpreted as native media instructions. Missing
instructions receive a generic instruction for the supplied question type.
This adapter supports up to 256 questions, 2–255 Choice options, and 2–255 Score
levels. Fastino limits each rendered state-plus-question prompt to 65,536 tokens.
The service counts repeated state in each internal question pass; use reported
usage, not request bytes or question count, for accounting.

The adapter always sends **`store: false`**. Fastino documents that this disables
input/output retention while preserving billing metadata. It uses the documented
Bearer authentication alternative, with normal prepared provider headers,
proxy/TLS settings, deadline, cancellation, and dispatch-time authority checks.
There is no automatic retry, chat fallback, web grounding, or remote-image fetch.
Image state, sorting, tags, bounding boxes, and reasoning controls are not exposed
by this initial adapter, even where the vendor API supports additional inputs.

## Interpret results

GLiDE's [native Score contract](https://docs.fastino.ai/concepts/glide-score.md)
distinguishes integer `score` (the winning index) from fractional
`expected_level` (the weighted rubric position). OpenClaw's `score` preserves
**`expected_level`**, not the integer winner and not a recomputation from rounded
probabilities. Missing expected levels produce an invalid-response result.
Probabilities, reported token usage, model identity, and provider-specific
confidence are preserved. GLiDE's Choice/Score confidence is a top-two margin,
not interchangeable with another provider's confidence or verified correctness.

Check [Fastino's current pricing](https://docs.fastino.ai/pricing.md) and validate
thresholds on representative data. Benchmark cost per task is not API token
pricing. See [Decision models](/concepts/decision-models) for configuration,
privacy, and graceful unavailable outcomes.
