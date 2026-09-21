---
summary: "Choose decision models and define typed choices, scores, and Boolean judgments"
title: "Decision models"
read_when:
  - Choosing between a chat, utility, or decision model
  - Defining classification or scoring rubrics
  - Calling or implementing the decision model plugin API
---

# Decision models

A **decision model** evaluates supplied evidence against a rubric and returns a
typed answer: a choice, a score, or a Boolean probability. Use it for bounded
judgments such as routing a request, scoring its urgency, or checking whether it
meets a condition.

`decisionModel` is a model role with a shared API. Its providers can use different
model architectures and inference backends. Sharing the interface does not make
their reasoning ability or probabilities interchangeable.

The role and TypeSafe AI adapter were added after released OpenClaw
`2026.9.5`. These instructions apply to development checkouts containing those
features and to later releases that include them. See each provider's setup
page for its host requirements.

| Role            | Typical work                                             | Result                                  |
| --------------- | -------------------------------------------------------- | --------------------------------------- |
| Primary model   | Conversation and agent work                              | Messages and tool calls                 |
| `utilityModel`  | Short language tasks such as titles and summaries        | Generated text                          |
| `decisionModel` | Classification, rubric scoring, and predicate evaluation | Typed answers and probability estimates |

Decision models have a separate **Decision** picker in the Control UI. Selecting
one makes it available to supported consumers; it does not start background work,
replace the chat model, or enable an agent tool. Consumers retain control over
when to evaluate evidence and what to do with the result.

## Choose a provider and model

Configure the provider plugin before selecting its model:

- [ONNX](/plugins/onnx) runs local CPU classifiers in a persistent subprocess.
  Follow its development-checkout or compatible-package setup, then explicitly
  download the model or prepare a local export. Inference needs no hosted API credential.
- [TypeSafe AI](/plugins/typesafe) connects to hosted Jev or a local System One
  server such as Kev. Install and enable the external plugin, then configure a
  protected hosted credential or an explicit loopback `baseUrl`. Hosted
  evaluations send the selected evidence to TypeSafe and incur its normal usage charges.

The current plugins declare these model references:

| Model reference                      | Model                  | Preparation                                            |
| ------------------------------------ | ---------------------- | ------------------------------------------------------ |
| `onnx/deberta-v3-base-zeroshot-v2.0` | DeBERTa Zero-shot v2   | Download pinned ONNX artifacts                         |
| `onnx/gliclass-base-v3.0`            | GLiClass Base v3       | Download pinned ONNX artifacts                         |
| `onnx/gliclass-edge-v3.0`            | GLiClass Edge v3       | Download pinned ONNX artifacts                         |
| `onnx/gliclass-instruct-base-v1.0`   | GLiClass Instruct Base | Local export                                           |
| `onnx/gliclass-instruct-edge-v1.0`   | GLiClass Instruct Edge | Local export                                           |
| `onnx/gliner2.5-base-v1`             | GLiNER 2.5 Base        | Download pinned ONNX artifacts                         |
| `onnx/gliner2.5-small-v1`            | GLiNER 2.5 Small       | Download pinned ONNX artifacts                         |
| `typesafe/jev-1.13.0`                | Jev 1.13.0             | TypeSafe credential                                    |
| `typesafe/jev-latest`                | Jev                    | TypeSafe credential; follows the vendor's latest model |
| `typesafe/kev-latest`                | Kev (local server)     | Running System One server and explicit loopback URL    |

Both plugins are currently unpublished candidates. Their setup pages explain
source-checkout use and the packaged host floor. The table describes the plugins' declared models,
not which artifacts or credentials are ready on your machine.

After provider setup, merge the role selection into your configuration:

```json5
{
  agents: {
    ownership: "explicit",
    defaults: { decisionModel: "onnx/gliclass-edge-v3.0" },
    entries: {
      support: { decisionModel: "typesafe/jev-latest" },
      quiet: { decisionModel: "" },
    },
  },
}
```

An unset agent override inherits the global default. An empty agent override
disables decisions for that agent. An unset or empty global default leaves the
role off. There is no automatic fallback to a conversational model.

For local setup verification, `openclaw onnx models` lists the presets and
`openclaw onnx probe gliclass-edge-v3.0` runs a Choice, Score, and Boolean smoke
evaluation after the model has been downloaded.

## Define a decision

Each request contains shared `state` and a `questions` map. State accepts text,
a JSON object or array, or `null`. Question keys identify answers;
the `instructions` and `criteria` define the judgment. The rubric travels with
each request, so there is no separate rubric-registration step.

| Question type | Criteria                                 | Answer                                                     |
| ------------- | ---------------------------------------- | ---------------------------------------------------------- |
| `choice`      | An object mapping labels to descriptions | `choice` and a `probabilities` object with the same labels |
| `score`       | An ordered array of rubric descriptions  | Fractional `score` and index-aligned `probabilities`       |
| `boolean`     | Descriptions under `true` and `false`    | `probabilityTrue`, from 0 to 1                             |

Use descriptive alternatives and observable score anchors. Give Boolean questions
both descriptions when targeting ONNX. Keep evidence focused on the question;
ONNX's token budget includes the state, instructions, and rubric.

## Call from a plugin

Call from a live tool, hook, or other owned operation. Here `api` is the plugin
API, `agentId` identifies the agent owning the work, and `signal` is that
operation's cancellation signal. The consumer needs no provider SDK or API key.

```ts
const outcome = await api.runtime.decisions.evaluate(
  {
    state: { message: "Checkout is failing for all customers." },
    questions: {
      route: {
        type: "choice",
        instructions: "Which team should handle this?",
        criteria: {
          support: "Technical problems and service outages",
          billing: "Invoices, refunds, and incorrect charges",
          sales: "Pricing and purchasing questions",
        },
      },
      urgency: {
        type: "score",
        instructions: "Assess the operational impact.",
        criteria: [
          "No service disruption",
          "Minor inconvenience with a workaround",
          "An important workflow is blocked",
          "A widespread production outage",
        ],
      },
      escalate: {
        type: "boolean",
        instructions: "Does this require human incident response?",
        criteria: {
          true: "A serious service incident needs human attention",
          false: "A routine request can follow normal handling",
        },
      },
    },
  },
  {
    agentId,
    purpose: "support.triage",
    rubricVersion: "1",
    timeoutMs: 30000,
    signal,
  },
);
```

The host selects the provider and model from the owning agent's configuration.
`purpose` identifies the consumer operation; `rubricVersion` identifies its rubric
in result provenance. They do not replace question instructions. Change the
rubric version when its meaning changes. Omit `agentId` only when intentionally
using global-default selection.

An `ok` outcome contains `outcome.result.answers`, keyed by the submitted question
IDs, plus the resolved model, optional usage, and provider/rubric/runtime provenance.
For example, these are illustrative answers, not a promised model response:

```json
{
  "route": {
    "type": "choice",
    "choice": "support",
    "probabilities": { "support": 0.97, "billing": 0.02, "sales": 0.01 }
  },
  "urgency": {
    "type": "score",
    "score": 2.85,
    "probabilities": [0, 0, 0.15, 0.85]
  },
  "escalate": { "type": "boolean", "probabilityTrue": 0.96 }
}
```

The host validates the complete batch before returning any answers. Narrow an
answer by its `type` before accessing type-specific fields in TypeScript.

## Interpret scores and probabilities

Scores are **zero-based rubric positions**. The four urgency descriptions above
define a scale from 0 to 3, including fractions. A score of 2.85 lies near the
highest-impact anchor. A display can rescale that position:

```ts
if (outcome.status === "ok") {
  const urgency = outcome.result.answers.urgency;
  if (urgency?.type === "score") {
    const scoreOutOf100 = (100 * urgency.score) / 3;
  }
}
```

The divisor is the last rubric index: `criteria.length - 1`. The display value
is a position on the scale, not a confidence percentage or probability of being
correct. Rubric wording determines what that scale means.

ONNX normalizes actual label logits with softmax. Choice uses the largest value;
Score is the probability-weighted rubric index. TypeSafe preserves Jev's reported
label, score, and probability estimates. Rounded vendor probabilities need not
sum exactly to one, and its reported score need not equal an expectation computed
from those rounded values.

Your consumer chooses an action policy, such as escalating when `probabilityTrue`
is at least 0.9. Validate that threshold on representative examples. Probabilities
and optional provider-specific `confidence` values are estimates, not demonstrated
accuracy guarantees. An answer does not grant permission to send a message or
perform another effect.

## Limits and unavailable results

For rubrics that fit both current providers, use 2–64 Choice alternatives, 2–10
Score levels, and explicit true/false descriptions. Provider limits differ:

| Provider    | Choice alternatives | Score levels | Additional limits                                                                  |
| ----------- | ------------------- | ------------ | ---------------------------------------------------------------------------------- |
| ONNX        | 2–64                | 2–64         | Up to 32 questions; 512 tokens per encoded input; one MiB of compiled batch inputs |
| TypeSafe AI | 2–255               | 2–10         | Subject to the host's batch limits and the vendor input contract                   |

The host bounds requests to one MiB and 256 questions. It admits at most four
requests per provider and caps each deadline at 30 seconds. Provider-specific
limits can be tighter. Unsupported input is rejected instead of silently truncated.

An `unavailable` outcome includes a reason such as `disabled`, `not-configured`,
`unsupported-input`, `overloaded`, or `deadline`. The consumer decides whether to
skip, defer, or use its existing fallback. Caller cancellation, closed consumer
authority, and contract errors reject; do not turn cancellation into fallback work.
See the [SDK contract](/plugins/sdk-overview/capabilities#decision-models-contract-version-1)
for the complete lifecycle and error behavior.

For ONNX, cold-loading a large model can exceed the deadline on slower machines.
Keep active models warm when memory permits, or choose a smaller model. See
[ONNX lifecycle and runtime](/plugins/onnx#lifecycle-and-runtime) for cache settings
and the effect of active cancellation. For missing TypeSafe credentials, follow
its [setup instructions](/plugins/typesafe#enable-and-configure).

## Provide models from a plugin

A provider plugin implements `DecisionProviderV1` from
`openclaw/plugin-sdk/decisions` and registers it with
`api.registerDecisionProvider(provider)`. Its `id` and `contractVersion: 1`
identify the contract; `evaluate(batch, context)` returns validated typed answers
or a supported unavailable reason. The context includes the selected model,
optional agent ID, composed cancellation signal, and monotonic deadline.

Declare provider ownership and static model metadata in the plugin manifest:

```json
{
  "contracts": { "decisionProviders": ["example-decisions"] },
  "decisionModels": [{ "provider": "example-decisions", "id": "fast", "name": "Fast decisions" }]
}
```

This manifest fragment exposes the selector `example-decisions/fast` in the
separate decision catalog. The consumer uses the same evaluation API for every
provider. It does not register a provider itself.

Providers own model-specific input translation, transport or local inference,
prepared credentials where needed, and physical cleanup on cancellation.
Registration and optional `isReady()` must be synchronous and network-free;
`isReady()` checks prepared credential availability, not model warmup. Return real
model estimates rather than manufacturing certainty from a label-only response.

The [provider contract](/plugins/sdk-overview/capabilities#decision-models-contract-version-1)
owns the full SDK rules; the [manifest reference](/plugins/manifest/capabilities#decision-models-reference)
owns discovery fields. For existing integrations, use the [ONNX](/plugins/onnx)
or [TypeSafe AI](/plugins/typesafe) setup pages.
