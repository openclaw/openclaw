---
summary: "Run OpenClaw through inferrs (OpenAI-compatible local server)"
read_when:
  - You want to run OpenClaw against a local inferrs server
  - You are serving Gemma or another model through inferrs
  - You need the exact OpenClaw compat flags for inferrs
title: "inferrs"
---

# inferrs

[inferrs](https://github.com/ericcurtin/inferrs) can serve local models behind an
OpenAI-compatible `/v1` API. OpenClaw works with `inferrs` through the generic
`openai-completions` path.

`inferrs` is currently best treated as a custom self-hosted OpenAI-compatible
backend, not a dedicated OpenClaw provider plugin.

## Quick start

1. Start `inferrs` with a model.

Example:

```bash
inferrs serve gg-hf-gg/gemma-4-E2B-it \
  --host 127.0.0.1 \
  --port 8080 \
  --device metal
```

2. Verify the server is reachable.

```bash
curl http://127.0.0.1:8080/health
curl http://127.0.0.1:8080/v1/models
```

3. Add an explicit OpenClaw provider entry and point your default model at it.

## Full config example

This example uses Gemma 4 on a local `inferrs` server.

```json5
{
  agents: {
    defaults: {
      model: { primary: "inferrs/gg-hf-gg/gemma-4-E2B-it" },
      models: {
        "inferrs/gg-hf-gg/gemma-4-E2B-it": {
          alias: "Gemma 4 (inferrs)",
        },
      },
    },
  },
  models: {
    mode: "merge",
    providers: {
      inferrs: {
        baseUrl: "http://127.0.0.1:8080/v1",
        apiKey: "inferrs-local",
        api: "openai-completions",
        models: [
          {
            id: "gg-hf-gg/gemma-4-E2B-it",
            name: "Gemma 4 E2B (inferrs)",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 131072,
            maxTokens: 4096,
            compat: {
              requiresStringContent: true,
            },
          },
        ],
      },
    },
  },
}
```

## Why `requiresStringContent` matters

Some `inferrs` Chat Completions routes accept only string
`messages[].content`, not structured content-part arrays.

If OpenClaw runs fail with an error like:

```text
messages[1].content: invalid type: sequence, expected a string
```

set:

```json5
compat: {
  requiresStringContent: true
}
```

OpenClaw will flatten pure text content parts into plain strings before sending
the request.

## Gemma and tool-schema caveat

Some current `inferrs` + Gemma combinations accept small direct
`/v1/chat/completions` requests but still fail on full OpenClaw agent-runtime
turns.

If that happens, try this first:

```json5
compat: {
  requiresStringContent: true,
  supportsTools: false
}
```

That disables OpenClaw's tool schema surface for the model and can reduce prompt
pressure on stricter local backends.

If tiny direct requests still work but normal OpenClaw agent turns continue to
crash inside `inferrs`, the remaining issue is usually upstream model/server
behavior rather than OpenClaw's transport layer.

## Manual smoke test

Once configured, test both layers:

```bash
curl http://127.0.0.1:8080/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"gg-hf-gg/gemma-4-E2B-it","messages":[{"role":"user","content":"What is 2 + 2?"}],"stream":false}'

openclaw infer model run \
  --model inferrs/gg-hf-gg/gemma-4-E2B-it \
  --prompt "What is 2 + 2? Reply with one short sentence." \
  --json
```

If the first command works but the second fails, use the troubleshooting notes
below.

## Troubleshooting

- `curl /v1/models` fails: `inferrs` is not running, not reachable, or not
  bound to the expected host/port.
- `messages[].content ... expected a string`: set
  `compat.requiresStringContent: true`.
- Direct tiny `/v1/chat/completions` calls pass, but `openclaw infer model run`
  fails: try `compat.supportsTools: false`.
- OpenClaw no longer gets schema errors, but `inferrs` still crashes on larger
  agent turns: treat it as an upstream `inferrs` or model limitation and reduce
  prompt pressure or switch local backend/model.

## Proxy-style behavior

`inferrs` is treated as a proxy-style OpenAI-compatible `/v1` backend, not a
native OpenAI endpoint.

- native OpenAI-only request shaping does not apply here
- no `service_tier`, no Responses `store`, no prompt-cache hints, and no
  OpenAI reasoning-compat payload shaping
- hidden OpenClaw attribution headers (`originator`, `version`, `User-Agent`)
  are not injected on custom `inferrs` base URLs

## See also

- [Local models](/gateway/local-models)
- [Gateway troubleshooting](/gateway/troubleshooting#local-openai-compatible-backend-passes-direct-probes-but-agent-runs-fail)
- [Model providers](/concepts/model-providers)
