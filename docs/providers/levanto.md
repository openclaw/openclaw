---
summary: "Connect Levanto Sage for native typed decisions"
read_when:
  - You want to use Sage as a decision model
  - You need Sage's supported operations and billing limitations
  - You want Levanto's LLMs as a chat model
title: "Levanto Sage"
---

The optional Levanto plugin connects Sage to OpenClaw's [decision model](/concepts/decision-models)
role. It does not provide chat completions; for Levanto's LLMs, see
[LLMs as a chat model](#llms-as-a-chat-model).

It needs OpenClaw `2026.11.5` or later. Each plugin release requires a host with
at least its own plugin API version, so install the plugin version that matches
your OpenClaw release. Extended-stable `2026.10.x` hosts refuse the install. Do
not override host-version checks to force installation.

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

The selectable catalog ID is `levanto-sage`. The Decision picker reads it from the
hosted model catalog, falling back to the installed manifest row; Sage has no live
model listing. A response may report
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

## Extraction through the Levanto MCP server

The plugin connects Sage only as a decision model. For Sage extraction, which
reads typed fields from a document with the text each value came from, add
Levanto's [MCP server](/cli/mcp). It gives agents `decide` and `extract` tools:

```bash
openclaw mcp set levanto '{"command":"npx","args":["-y","levanto@latest","mcp"],"env":{"LEVANTO_API_KEY":"${LEVANTO_API_KEY}"}}'
```

`${LEVANTO_API_KEY}` is read from the environment OpenClaw runs in, so the key
isn't stored in config. The server needs Node.js 18 or later. Run
`openclaw mcp probe levanto` to check that it lists its tools. These calls are
agent tool calls billed by Levanto; they don't use the decision model role.

## LLMs as a chat model

Levanto's LLM API is OpenAI-compatible, so it works as a
[custom provider](/concepts/model-providers/custom-providers) without the plugin:

```json5
{
  models: {
    providers: {
      "levanto-llm": {
        baseUrl: "https://api.levanto.ai/v1",
        apiKey: "${LEVANTO_API_KEY}",
        api: "openai-completions",
        models: [
          { id: "auto", name: "Auto", contextWindow: 1048576, maxTokens: 65536 },
          {
            id: "deepseek/deepseek-v4-flash",
            name: "DeepSeek V4 Flash",
            contextWindow: 1048576,
            maxTokens: 65536,
          },
        ],
      },
    },
  },
}
```

Then select it with `openclaw models set levanto-llm/auto`. `auto` lets Levanto
pick a model for each request; the reply's `model` names the model that answered.
Replies report the billed amount in `usage.cost`, so usage shows the provider-billed
cost even though these model entries carry no prices. `GET https://api.levanto.ai/v1/models`
lists the other model IDs.

See the vendor [decision documentation](https://docs.levanto.ai/llms.txt),
[pricing](https://docs.levanto.ai/pricing.md) and [OpenAPI](https://sage.levanto.ai/openapi.json).
