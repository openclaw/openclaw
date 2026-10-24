---
summary: "Connect Levanto Sage for native typed decisions"
read_when:
  - You want to use Sage as a decision model
  - You need Sage's supported operations and billing limitations
title: "Levanto Sage"
---

The optional Levanto plugin connects Sage to OpenClaw's [decision model](/concepts/decision-models)
role. It does not provide chat completions. It requires the prepared version-2
decision provider API. Released OpenClaw `2026.10.4` exposes V1 only and cannot
load this adapter.

For development, use a matching source checkout containing both the prepared V2
runtime and this plugin. Packaged use requires a supporting paired host/plugin
release. The normal release process aligns the plugin API and build versions
with that host; the package's older installation floor alone does not establish
V2 compatibility. Do not override host-version checks to force installation.

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
remain owned by OpenClaw's common provider request path. Inference consumes the
host-prepared credential and effective private headers, including resolved SecretRefs;
it does not reread configured auth values, read environment keys, or use headers as an
alternate credential source. A foreign base URL override does not inherit Sage
capabilities: the owning plugin must explicitly declare that native route and
protocol in its [model catalog](/plugins/manifest/models#task-specific-inference-metadata).
An empty chat-model list is not such a declaration.

## Native operations

Consumers use [`api.runtime.decisions.evaluateV2`](/plugins/sdk-overview/capabilities#prepared-decision-execution-contract-version-2).
The V1 adapter still refuses richer results it cannot represent; selecting Sage
does not establish V1-only consumer or Auto compatibility.
Only explicitly supplied content is sent. One question uses `POST /decide`;
multiple questions use one grouped `POST /decide/batch`, not hidden fan-out.

| OpenClaw kind | Sage kind | Semantics and bounds                                                                                                                                               |
| ------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Boolean       | Yes/No    | `probabilityTrue` is P(yes). `answer: null` is successful abstention.                                                                                              |
| Choice        | Choice    | 2–120 options; at most 20 for images. Preserve the chosen option, nullable selected probability and categorical distribution; do not normalize or take its argmax. |
| Score         | Scale     | 2–26 rubric levels, indexed from zero. Preserve the fractional expectation, provider confidence and supplied per-level distribution.                               |
| Sort          | Sort      | A list of 2–120 items; preserves the native order and optional list-level confidence. No image sorting.                                                            |
| Tags          | Tags      | 1–120 labels. Text verdicts may be null; image verdicts are Boolean.                                                                                               |

Text and JSON evidence are rendered as text. List item bodies and rubric entries
retain their supplied text or JSON representation. Boolean true/false criteria,
when present, are included explicitly in the native question instructions.

Inline PNG, JPEG and WebP images are supported: at most 4 MiB decoded, a longest
edge of 8192 pixels and area of 4096² pixels. The common media probe validates
image dimensions. Remote image URLs, filesystem paths, list-contained images and
image Sort are not accepted. Callers still own authority to submit the image.

The caller can select `auto`, `off` or `on` reasoning. Omission retains Sage's
`off` default. Its internal reasoning limit is ten seconds, but never extends
the caller's deadline. Allow more than ten seconds when requesting reasoning.
Returned reasoning metadata describes execution, not a prose reasoning trace.

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
`levanto-sage-v1.3`; neither is a request-level version pin. Sage documents no model
selector in these request bodies.

Reported `meta.usage.input_tokens` and `output_tokens` flow through the common
usage owner. Sage includes reasoning in those totals; the adapter does not add
`meta.reasoning.tokens` again. Native usage, including image counts and tokens,
is retained unchanged. If usage is absent, it remains unknown.

Sage charges per input token, output token and grounding search at the account's
plan rates. This adapter omits grounding, declares token billing without fixed
rates, and does not invent a dollar cost or report missing cost as zero.
Plan-dependent context limits are not inferred from the catalog.

See the vendor [decision documentation](https://docs.levanto.ai/llms.txt),
[pricing](https://docs.levanto.ai/pricing.md) and [OpenAPI](https://sage.levanto.ai/openapi.json).
