---
summary: "Use any /rerank endpoint (vLLM, TEI, Infinity, Cohere, Jina, Voyage) as a Decision model"
read_when:
  - You already run a reranker and want to use it as a Decision model
  - You want a local, keyless Decision model for the Knowledge recall gate
title: "Rerank (Decision models)"
---

# Rerank

The bundled `rerank` plugin turns any reranker behind a `/rerank` endpoint into
a [Decision model](/concepts/decision-models). It ships with OpenClaw and is
enabled by default; it does nothing until you configure an endpoint.

A reranker answers one question: how relevant is this document to this query?
That is the shape of many Decision questions, such as the
[Knowledge recall gate](/plugins/knowledge/memory-provider#recall-gate) asking
"would this page help answer the message?". If you already run a reranker,
it works as a Decision model with no extra plugin.

## Supported servers

Any server that speaks the common `/rerank` API:

| Server                | Base URL example              |
| --------------------- | ----------------------------- |
| vLLM (`--task score`) | `http://127.0.0.1:8000/v1`    |
| Hugging Face TEI      | `http://127.0.0.1:8080`       |
| Infinity              | `http://127.0.0.1:7997`       |
| Cohere                | `https://api.cohere.com/v2`   |
| Jina                  | `https://api.jina.ai/v1`      |
| Voyage                | `https://api.voyageai.com/v1` |

OpenClaw posts to `<baseUrl>/rerank` with `model`, `query`, and the documents.
Most servers read the documents from `documents`; TEI reads `texts`. When an
endpoint rejects the first form, OpenClaw retries once with `texts` and
remembers the working form for that endpoint.

Responses may use the Cohere shape (`results[].relevance_score`), Voyage's
`data[]`, or TEI's bare array of `{ index, score }`. Scores must be relevance
probabilities from 0 to 1. Cohere, Jina and Voyage return them, as does TEI
with `raw_scores` off; check the score setting of other servers. A response with any score outside that range is
rejected as `invalid-response`: rescaling a batch from its own values would
move one page's score with its neighbours, so serve raw-logit models (for
example llama.cpp's `--reranking`) behind a sigmoid.

## Configure

List the endpoint and the model under `models.providers.rerank`, then select
it as the Decision model:

```json5
{
  models: {
    providers: {
      rerank: {
        baseUrl: "http://127.0.0.1:8000/v1",
        models: [
          { id: "Alibaba-NLP/gte-reranker-modernbert-base", name: "GTE reranker ModernBERT" },
        ],
      },
    },
  },
  agents: {
    defaults: { decisionModel: "rerank/Alibaba-NLP/gte-reranker-modernbert-base" },
  },
}
```

Any reranker your server hosts works; `Alibaba-NLP/gte-reranker-modernbert-base`
is the recommended model for the Knowledge recall gate (see below).

- The model `id` is sent as `model` in each request. Use the name your server
  expects.
- A self-hosted server needs no credential. For a hosted API, set
  `models.providers.rerank.apiKey` (a [SecretRef](/gateway/secrets) is
  recommended) or the `RERANK_API_KEY` environment variable. OpenClaw sends it
  as `Authorization: Bearer <key>`.
- Private and LAN addresses are allowed because you authored the endpoint. Set
  `models.providers.rerank.request.allowPrivateNetwork: false` to refuse them.
- The plugin declares the model as Decision-only; it is never offered as a chat
  model.

The plugin serves one provider entry, `rerank`, so it points at one server. List
every model that server hosts under `models.providers.rerank.models`. Other
provider IDs (for example `rerank-home`) are not handled by this plugin.

## What a reranker can answer

The plugin maps Decision questions onto rerank calls. Questions in one request
that share a query go to the server in one call.

| Question type | Query                         | Documents                                               | Answer                                             |
| ------------- | ----------------------------- | ------------------------------------------------------- | -------------------------------------------------- |
| `boolean`     | The state text                | The question's `instructions` (or its `true` criterion) | `probabilityTrue` is the relevance score           |
| `choice`      | The state text                | Each option's description, or its label                 | Highest-scoring option; per-option `probabilities` |
| `sort`        | The question's `instructions` | Each item of a `list` state                             | Items ordered by score                             |

- Choice probabilities are independent relevance scores, not a distribution
  that sums to 1.
- `score`, `tags`, and `box` questions and image state are not supported; a
  request containing one returns `unsupported-input` without a server call.
- JSON state is sent as its JSON text.

Relevance is not the same as reasoning. A reranker is a good fit for "does
this text match that one" judgments and a poor fit for rubric scoring or
multi-step logic. Use a native Decision provider for those.

## Recall gate example

The Knowledge [recall gate](/plugins/knowledge/memory-provider#recall-gate)
asks one `boolean` question per candidate page. By default the candidates come
from keyword search, the state is the bare user message, and each question
carries the page title and its best passages, so every question maps onto one
(query, document) pair in a single rerank call. The recommended model is
[`Alibaba-NLP/gte-reranker-modernbert-base`](https://huggingface.co/Alibaba-NLP/gte-reranker-modernbert-base);
the gate's defaults were measured with it:

```json5
{
  models: {
    providers: {
      rerank: {
        baseUrl: "http://127.0.0.1:8080",
        models: [
          { id: "Alibaba-NLP/gte-reranker-modernbert-base", name: "GTE reranker ModernBERT" },
        ],
      },
    },
  },
  agents: {
    defaults: { decisionModel: "rerank/Alibaba-NLP/gte-reranker-modernbert-base" },
  },
  plugins: {
    entries: { knowledge: { config: { recallGate: { mode: "shadow" } } } },
  },
}
```

Reranker scores are not calibrated probabilities, and each model scores on its
own scale. With a different model, run the gate in `shadow` mode first and
tune `highThreshold` against its logged scores before switching to `live`.

## Privacy

Every evaluation sends the state text and the question documents to the
configured endpoint. Use a local server for private conversations.
