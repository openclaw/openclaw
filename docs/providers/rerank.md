---
summary: "Use any /rerank endpoint (vLLM, TEI, Infinity, llama.cpp, Cohere, Jina, Voyage) as a Decision model"
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

| Server                           | Base URL example              |
| -------------------------------- | ----------------------------- |
| vLLM (`--task score`)            | `http://127.0.0.1:8000/v1`    |
| Hugging Face TEI                 | `http://127.0.0.1:8080`       |
| Infinity                         | `http://127.0.0.1:7997`       |
| llama.cpp server (`--reranking`) | `http://127.0.0.1:8080/v1`    |
| Cohere                           | `https://api.cohere.com/v2`   |
| Jina                             | `https://api.jina.ai/v1`      |
| Voyage                           | `https://api.voyageai.com/v1` |

OpenClaw posts to `<baseUrl>/rerank` with `model`, `query`, and the documents.
Most servers read the documents from `documents`; TEI reads `texts`. When an
endpoint rejects the first form, OpenClaw retries once with `texts` and
remembers the working form for that endpoint.

Responses may use the Cohere shape (`results[].relevance_score`), Voyage's
`data[]`, or TEI's bare array of `{ index, score }`. Scores already in 0 to 1
are used as they are; raw logits go through a sigmoid.

## Configure

List the endpoint and the model under `models.providers.rerank`, then select
it as the Decision model:

```json5
{
  models: {
    providers: {
      rerank: {
        baseUrl: "http://127.0.0.1:8000/v1",
        models: [{ id: "BAAI/bge-reranker-v2-m3", name: "BGE reranker v2 m3" }],
      },
    },
  },
  agents: {
    defaults: { decisionModel: "rerank/BAAI/bge-reranker-v2-m3" },
  },
}
```

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

The Knowledge recall gate asks one `boolean` question per memory page, with
the page label in `instructions`, and a `choice` question to shortlist large
indexes. Both map directly onto rerank calls:

```json5
{
  models: {
    providers: {
      rerank: {
        baseUrl: "http://127.0.0.1:8080",
        models: [{ id: "BAAI/bge-reranker-v2-m3", name: "BGE reranker v2 m3" }],
      },
    },
  },
  agents: { defaults: { decisionModel: "rerank/BAAI/bge-reranker-v2-m3" } },
  plugins: {
    entries: { knowledge: { config: { recallGate: { mode: "shadow" } } } },
  },
}
```

Reranker scores are not calibrated probabilities. Run the gate in `shadow`
mode first and tune `highThreshold` and `mediumThreshold` against its logs
before switching to `live`.

## Privacy

Every evaluation sends the state text and the question documents to the
configured endpoint. Use a local server for private conversations.
