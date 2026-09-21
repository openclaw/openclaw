---
summary: "Run typed decisions locally with verified ONNX classifiers"
title: "Local ONNX decision models"
read_when:
  - You want a local decision model without a hosted API
  - You are installing or checking ONNX model artifacts
---

# Local ONNX decision models

The installable **ONNX** plugin runs classifiers locally through the
[decision model API](/plugins/sdk-overview/capabilities#decision-models-contract-version-1).
It uses a separate, persistent Node process with ONNX Runtime's CPU backend.
Inference does not send state or questions to a remote service. Models download
only when you explicitly run the download command.

See [Decision models](/concepts/decision-models) for the model role, rubric
examples, and provider-neutral plugin API.

## Setup

The decision-provider API was added after released OpenClaw `2026.9.5`.
Packaged ONNX installs require a host and plugin API of at least `2026.9.6`;
the installer rejects `2026.9.5` before loading the plugin. The native runtime
belongs to the plugin package and is not bundled into core.

### Current development checkout

Until a supporting release is available, use an OpenClaw source checkout that
contains both the decision-provider API and `extensions/onnx`. Build that
checkout with `pnpm install --frozen-lockfile` and `pnpm build`, then enable the
plugin and select its model using the configuration below. Run commands from
the checkout:

```sh
pnpm openclaw onnx models
pnpm openclaw onnx download gliclass-edge-v3.0
pnpm openclaw onnx probe gliclass-edge-v3.0
```

The checkout's co-versioned source plugins use the host's development API. This
does not make a packaged plugin compatible with a released `2026.9.5` host.

### Packaged installation

On a compatible host, install the locally built package and prepare a model:

```sh
openclaw plugins install npm-pack:/path/to/openclaw-onnx.tgz
openclaw onnx models
openclaw onnx download gliclass-edge-v3.0
openclaw onnx probe gliclass-edge-v3.0
```

### Configuration

Select the role globally or for one agent:

```json5
{
  agents: {
    defaults: { decisionModel: "onnx/gliclass-edge-v3.0" },
  },
  plugins: {
    entries: {
      onnx: {
        enabled: true,
        config: { threads: 2, maxLoadedModels: 2 },
      },
    },
  },
}
```

The default artifact directory is `<stateDir>/models/onnx`. Set the plugin's
`modelDir` to use another directory; the download, verify, and probe commands also
accept `--model-dir <path>`. Artifacts are grouped by model ID. Downloads use fixed
repository revisions, sizes, and SHA256 hashes. Existing mismatched files are
refused rather than overwritten. `openclaw onnx verify <model>` checks an installation.
Verification and cached-download checks stream the files, so checking a large
graph does not require a graph-sized memory buffer. Inference still loads
verified graph bytes into its worker.

## Models

| Model ID                        | Source                                         | Preparation  |
| ------------------------------- | ---------------------------------------------- | ------------ |
| `deberta-v3-base-zeroshot-v2.0` | Moritz Laurer's official ONNX export           | `download`   |
| `gliclass-base-v3.0`            | Knowledgator model, cnmoro ONNX conversion     | `download`   |
| `gliclass-edge-v3.0`            | Knowledgator model, cnmoro ONNX conversion     | `download`   |
| `gliclass-instruct-base-v1.0`   | Knowledgator model                             | Local export |
| `gliclass-instruct-edge-v1.0`   | Knowledgator model                             | Local export |
| `gliner2.5-base-v1`             | Fastino model, nicolasembleton ONNX conversion | `download`   |
| `gliner2.5-small-v1`            | Fastino model, nicolasembleton ONNX conversion | `download`   |

The hosted presets use FP32 graphs. Model licenses and conversion sources are
linked from the original [GLiClass](https://github.com/Knowledgator/GLiClass),
[GLiNER2](https://github.com/fastino-ai/GLiNER2), and
[DeBERTa model](https://huggingface.co/MoritzLaurer/deberta-v3-base-zeroshot-v2.0)
pages. Downloaded weights remain separate from OpenClaw's package.

For Instruct models, use the installed plugin's `dist/scripts/export-gliclass-instruct.py`
helper with the pinned Python packages listed by `--help`. Supply a local copy of
the exact official checkpoint revision printed by `openclaw onnx models`:

```sh
python export-gliclass-instruct.py --model edge \
  --source /path/to/checkpoint \
  --output /path/to/models/gliclass-instruct-edge-v1.0
openclaw onnx verify gliclass-instruct-edge-v1.0 --model-dir /path/to/models
```

The helper verifies the source files, runs without remote model code or downloads,
and creates a fresh directory containing the graph, tokenizer, and `model.json`
export manifest. Local exports are operator-supplied artifacts: the runtime checks
their declared source revision and file hashes. Their graph hash is not a published
third-party attestation. Few-shot example sections are not supported by this export.

## Question semantics

These models classify text against a rubric. JSON state and rubric entries are
serialized as text; instructions and criterion descriptions condition classification.
Use descriptive criteria rather than opaque IDs when possible.

- **Choice:** softmax over the model's complete label logits; highest-probability label wins.
- **Score:** classify the ordered criterion levels, then return their expected zero-based index.
- **Boolean:** supply both `criteria.true` and `criteria.false` as meaningful predicate
  descriptions. Bare Boolean questions are unsupported because labels such as
  `true` and `false` do not reliably express a zero-shot predicate.

Probabilities are model estimates, not calibrated guarantees. These classifiers
are not interchangeable with Jev on every reasoning task. Validate the rubric on
representative examples before relying on its decision quality.

The plugin supports up to 32 questions and 64 labels per question, with a one-MiB
limit on compiled inputs across the batch. Each encoded
input, including its rubric, must fit 512 tokens. It rejects unsupported input
instead of truncating it. GLiClass reserves its label, separator, and example
markers. GLiNER2.5 also rejects the schema's reserved markers and parentheses in
rubrics; ordinary state text can contain punctuation.

## Lifecycle and runtime

Up to `maxLoadedModels` selected models warm during plugin service startup. Later
requests reuse native sessions; the resident cache evicts the least recently
used model when full. `threads` sets CPU intra-operation parallelism from 1 to 8.

Cold-loading a large model can exhaust a request's deadline on slower machines.
The host allows up to ten seconds; consumers can request less.
When agents use several models, set `maxLoadedModels` to
hold the active models if memory permits, or select a smaller model. The default
cache holds two models; the maximum is five.

The host still enforces its ten-second decision deadline and four-call provider
limit. The worker serializes native operations. A queued cancellation leaves the
warm process intact; cancelling active native work terminates and joins that
process before releasing the request. The next live request starts a fresh worker.
Plugin retirement stops the worker and its owned work.

The runtime requires supported Node.js and the optional `onnxruntime-node` native
package. CPU inference is the initial backend; GPU and WASM execution are not
enabled by this plugin. Native libraries and model tokenizers load inside the
worker, keeping them out of Gateway discovery and ordinary plugin registration.
