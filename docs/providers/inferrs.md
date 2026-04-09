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
inferrs serve google/gemma-4-E2B-it \
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
      model: { primary: "inferrs/google/gemma-4-E2B-it" },
      models: {
        "inferrs/google/gemma-4-E2B-it": {
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
            id: "google/gemma-4-E2B-it",
            name: "Gemma 4 E2B (inferrs)",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 131072,
            maxTokens: 4096,
          },
        ],
      },
    },
  },
}
```

## Manual smoke test

Once configured, test both layers:

```bash
curl http://127.0.0.1:8080/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"google/gemma-4-E2B-it","messages":[{"role":"user","content":"What is 2 + 2?"}],"stream":false}'

openclaw infer model run \
  --model inferrs/google/gemma-4-E2B-it \
  --prompt "What is 2 + 2? Reply with one short sentence." \
  --json
```

If the first command works but the second fails, use the troubleshooting notes
below.

## Troubleshooting

- `curl /v1/models` fails: `inferrs` is not running, not reachable, or not
  bound to the expected host/port.
- Direct tiny `/v1/chat/completions` calls pass, but `openclaw infer model run`
  fails: check `openclaw logs --follow` for the specific error and continue in
  the deep runbook below.
- `inferrs` crashes only on larger agent turns: reduce prompt pressure (shorter
  session history, lighter model) or upgrade `inferrs` to the latest release.
- On older `inferrs` releases (before structured content-part support was added),
  you may see `messages[].content: invalid type: sequence, expected a string`.
  Add `compat.requiresStringContent: true` as a workaround until you upgrade.

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
