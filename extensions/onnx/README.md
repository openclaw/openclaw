# @openclaw/onnx

Official local ONNX decision-model plugin for OpenClaw. It evaluates Choice,
Score, and Boolean rubrics with GLiClass, GLiNER2.5, and DeBERTa classifiers in a
persistent CPU inference process.

## Setup

Released OpenClaw `2026.9.5` lacks the decision-provider API. Packaged installs
require a host and plugin API of at least `2026.9.6`.

For development, use an OpenClaw checkout containing both the decision-provider
API and this plugin. Run `pnpm install --frozen-lockfile` and `pnpm build`, enable
`plugins.entries.onnx`, and run these commands from the checkout:

```sh
pnpm openclaw onnx models
pnpm openclaw onnx download gliclass-edge-v3.0
pnpm openclaw onnx probe gliclass-edge-v3.0
```

Select `onnx/gliclass-edge-v3.0` as `agents.defaults.decisionModel` or as an
agent's override. Inference stays local; model downloads use pinned revisions,
sizes, and SHA256 hashes. Large models may need preloading to meet the host's
30-second decision deadline.

On a compatible packaged host, install the local candidate with
`openclaw plugins install npm-pack:/path/to/openclaw-onnx.tgz`. A development
checkout's co-versioned source loading does not grant compatibility to an older
packaged host.

See [Local ONNX decision models](https://docs.openclaw.ai/plugins/onnx) for the
model catalog, configuration, local exports, and runtime limits. The
[Decision models guide](https://docs.openclaw.ai/concepts/decision-models)
explains rubric definitions, score semantics, and the plugin API shared with
TypeSafe AI.
