---
summary: "Use SubQ Snap for typed decisions, not chat completions"
title: "SubQ"
read_when:
  - Configuring SubQ Snap as a decision model
  - Using the SubQ Decisions API from OpenClaw
---

# SubQ

The `subq` plugin connects the optional [decision model role](/concepts/decision-models)
to the SubQ Decisions API, which hosts **SubQ Snap** models for Boolean judgments,
choices, and rubric scores. It does not replace your chat model or provide text
generation or agent tool calling.

<Warning>
SubQ retired `subq-snap-preview` on November 11, 2026 and now routes it to another
Snap model ([SubQ Models page](https://docs.subq.ai/using-the-api/models/)). OpenClaw
no longer lists or calls it, and currently lists no SubQ Decision model: SubQ
models will appear in the **Decision** picker once the hosted model catalog
publishes them. A saved `subq/subq-snap-preview` selection shows as unavailable,
and its evaluations return `unsupported-input` without contacting SubQ.
`openclaw doctor --fix` removes it.
</Warning>

## Install and configure

This is an external plugin candidate; package publication is pending. Until a
supporting release publishes it, use a source checkout containing
`extensions/subq`, install its dependencies, and build OpenClaw. The packaged
plugin declares OpenClaw and Plugin API `2026.10.3` or newer.

After publication, install it with `openclaw plugins install @openclaw/subq`.
Create a SubQ API key at [console.subq.ai](https://console.subq.ai/) and store it
in **Settings → Secrets**. Merge this configuration with your existing settings;
preserve other entries in `plugins.allow`:

```json5
{
  plugins: {
    allow: ["subq"],
    entries: {
      subq: {
        enabled: true,
        config: {
          apiKey: { source: "store", provider: "default", id: "SUBQ_API_KEY" },
        },
      },
    },
  },
}
```

The plugin is disabled by default. Enabling it does not select a model, schedule
work, or change your primary model. Select a SubQ model in the Decision picker when
the catalog lists one. An individual agent can set its own `decisionModel`; an empty
override disables that role for the agent.

Credentials must be SecretRefs, not plaintext. Environment, file, and exec
SecretRefs are also supported through the host's [secrets system](/gateway/secrets).
The plugin reads the prepared credential for each request; it does not read
ambient `SUBQ_API_KEY` itself or retain a previous key after a secret refresh.
Do not paste API keys in chat.

## Use

With the plugin configured, `decision_evaluate` sends only the supplied state
and questions to SubQ. For example:

```json
{
  "state": { "ticket": "Checkout is unavailable for all customers." },
  "questions": {
    "escalate": {
      "type": "boolean",
      "instructions": "Does this require human incident response?",
      "criteria": {
        "true": "A widespread service outage",
        "false": "A routine support question"
      }
    }
  }
}
```

The Boolean result preserves the vendor's probability of yes, rather than
thresholding it. Choice results preserve every alternative's probability;
Score results preserve fractional zero-based rubric positions and their
index-aligned probabilities. Optional confidence is vendor-specific, not a
probability that the model is correct. Results never authorize external actions.
Automatic experimental consumers still require the separate
[Decision assistance opt-in](/concepts/experimental-features#decision-assistance).

## API and limits

The adapter targets `POST https://api.subq.ai/v1/systemone` with Bearer auth and
sends the selected Decision model ID. It translates OpenClaw's `boolean` questions to
the API's `noul` type. It does not route Snap through OpenAI chat completions;
the separate `subq-preview` chat model is not part of this integration.

According to SubQ's public Decisions API documentation, checked November 12, 2026:

- Requests support 1–128 questions; question IDs are at most 100 characters.
- Choice questions support 2–255 alternatives; Score questions support 2–10 levels.
- Output tokens are free and reported as zero. Per-model prices and context
  windows are on the [Models page](https://docs.subq.ai/using-the-api/models/).
- The vendor API supports up to four PNG, JPEG, or WebP images, each up to 4 MiB
  decoded and 8 MiB decoded total, within a 13 MiB request body. It does not accept
  video.

**This V1 adapter is text/JSON only.** It does not expose the vendor API's image
input, fetch URLs, or reinterpret base64 in state as an image. Its host's
one-MiB input limit, 20,000 JSON-node limit, depth 32, and at-most-30-second deadline
still apply. Do not assume the entire advertised context window fits these bounds.
Use text, an object, or an array for state; null state is not part of the vendor's
documented request contract. Oversized/unsupported requests are rejected, not
split or truncated. The server enforces its token limit, including requests near
that limit; JSON bytes are not a token estimate.

Hosted evaluations send evidence to SubQ and may incur charges. The plugin never
retries a paid call automatically. Invalid credentials/access return
`authentication`; input rejection returns `unsupported-input`; rate limits return
`rate-limited`. Insufficient credit (HTTP 402) and service/network failures return
`transport`. Check credits and model access in the console. Error response bodies
are not exposed because they may contain supplied evidence or credentials.

## Sources and verification

- [SubQ Decisions API](https://docs.subq.ai/endpoints/decisions-api/)
- [Authentication](https://docs.subq.ai/using-the-api/authentication/)
- [Models and pricing](https://docs.subq.ai/using-the-api/models/)
- [Data retention](https://docs.subq.ai/using-the-api/data-retention/)

The adapter has synthetic HTTP-boundary tests for the documented wire format,
limits, errors, cancellation, and secret refresh. Authenticated live inference
has not been verified; a SubQ account with model access and credits is required.
Developers can run `pnpm test:live -- extensions/subq/src/runtime.live.test.ts`
with a protected `SUBQ_API_KEY` and the SubQ model ID in `SUBQ_DECISION_MODEL`. The live runner opts in
with `OPENCLAW_LIVE_TEST=1`; the test sends only its fixed synthetic example
and makes one paid request.
Vendor benchmark and latency claims are not OpenClaw validation results.
