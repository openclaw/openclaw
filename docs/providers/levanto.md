---
summary: "Connect Levanto Sage for native typed decisions"
read_when:
  - You want to use Sage as a decision model
  - You need Sage's supported operations and billing limitations
title: "Levanto Sage"
---

The optional Levanto plugin connects Sage to OpenClaw's [decision model](/concepts/decision-models)
role. It does not provide chat completions. It requires the prepared version-2 decision
provider API in OpenClaw **2026.9.6 or later**; an older host must not load it.

## Connect and select

Install and enable `@openclaw/levanto` through the normal [plugin installation](/tools/plugin)
flow on a compatible host. Use the normal provider connection flow or:

```bash
openclaw models auth login --provider levanto
```

The common credential owner captures the key with the masked prompt and supports normal
agent-scoped profiles and SecretRefs. `LEVANTO_API_KEY` is the advertised environment
source. Do not paste keys into chat. Connecting a key does not change either model role
or activate background evaluation.

Select `levanto/levanto-sage` for `agents.defaults.decisionModel` or an agent's
`decisionModel` override. The normal `provider/model@profile` syntax can pin an
agent-scoped credential profile. Do not set Sage as the conversational primary model.

The default endpoint is `https://sage.levanto.ai`. Normal configured provider URL
prefixes, effective request headers, proxy/TLS settings and private-network policy
remain owned by OpenClaw's common provider request path. Inference consumes only the
host-prepared credential; it does not read environment keys or use headers as an
alternate credential source.

## Native operations

Consumers use [`api.runtime.decisions.evaluateV2`](/plugins/sdk-overview/capabilities#prepared-version-2-providers).
Only explicitly supplied content is sent. One question uses `POST /decide`;
multiple questions use one grouped `POST /decide/batch`, not hidden fan-out.

| OpenClaw kind | Sage kind | Semantics and bounds                                                                                                                                                         |
| ------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Boolean       | Yes/No    | `probabilityTrue` is P(yes). `answer: null` is successful abstention.                                                                                                        |
| Choice        | Choice    | 2–120 options; at most 20 for images. Preserve the chosen option, nullable selected probability and independent per-option estimates; do not normalize or take their argmax. |
| Score         | Scale     | Exactly five rubric levels, indexed 0–4. Preserve the fractional expectation and provider confidence; no distribution is invented.                                           |
| Sort          | Sort      | A list of 2–120 items; preserves the native order and optional list-level confidence. No image sorting.                                                                      |
| Tags          | Tags      | 1–120 labels. Text verdicts may be null; image verdicts are Boolean.                                                                                                         |

Text and JSON evidence are rendered as text. List item bodies and rubric entries
retain their supplied text or JSON representation. Boolean true/false criteria,
when present, are included explicitly in the native question instructions.

Inline PNG, JPEG and WebP images are supported: at most 4 MiB decoded, a longest
edge of 8192 pixels and area of 4096² pixels. The common media probe validates
image dimensions. Remote image URLs, filesystem paths, list-contained images and
image Sort are not accepted. Callers still own authority to submit the image.

The caller can select `auto`, `off` or `on` reasoning. Omission retains Sage's
`auto` default. Its internal reasoning budget can be six seconds, but never extends
the caller's deadline. Use `off` for tight latency budgets. Returned reasoning
metadata describes execution, not a prose reasoning trace.

The initial shared V2 request has no grounding authorization input. This adapter
therefore **omits grounding**, even though the vendor supports it. It performs no
web search or implicit private fetch. There are no automatic retries, including
for abstention, partial batch failure, allowance exhaustion or HTTP 503.

## Results, usage and limitations

The V2 result retains the native response in its serializable `metadata.native`
envelope, including batch partial errors, call-level usage, reported model identity
and reasoning metadata. A failed batch question becomes an explicit error answer,
not a negative decision. Successful questions are retained.

The selectable catalog ID is `levanto-sage`. A response may report
`levanto-sage-v1.1`; neither is a request-level version pin. Sage documents no model
selector in these request bodies.

Reported billed input tokens flow through the common usage owner. Missing output
tokens remain unknown, and reasoning tokens are not silently relabeled as output
tokens. Native usage is also retained unchanged. The short pricing docs describe
monthly decision units, whereas the catalog still exposes token pricing. Current
short docs and OpenAPI say reasoning tokens are not billed. The adapter does not convert decision units
into dollars, apply token catalog rates, or report missing cost as zero. Exact
plan-dependent context limits are not invented.

See the vendor [decision documentation](https://docs.levanto.ai/llms.txt),
[pricing](https://docs.levanto.ai/pricing.md) and [OpenAPI](https://sage.levanto.ai/openapi.json).
