---
summary: "Nodecode setup, Cyber v1, thinking levels, and prompt caching"
title: "Nodecode"
read_when:
  - You want to use Nodecode's Cyber v1 with OpenClaw
  - You need Cyber v1's limits, prices, or thinking-level mapping
---

[Nodecode](https://nodecode.ai) serves Cyber v1, an abliterated DeepSeek V4.1
Flash for security work, through an OpenAI-compatible API. Foresight Labs runs
it on its own machines in Europe with zero data retention. OpenClaw provides it
as an official external provider plugin with live model listing and API-key
authentication. Vendor-side policies apply to every request.

| Property        | Value                                    |
| --------------- | ---------------------------------------- |
| Provider id     | `nodecode`                               |
| Package         | `@openclaw/nodecode-provider`            |
| Auth env var    | `NODECODE_API_KEY`                       |
| Onboarding flag | `--auth-choice nodecode-api-key`         |
| Direct CLI flag | `--nodecode-api-key <key>`               |
| API             | OpenAI-compatible (`openai-completions`) |
| Base URL        | `https://api.nodecode.ai/v1`             |
| Default model   | `nodecode/nodecode-cyber-v1`             |

## Setup

Create a key at [nodecode.ai/account/keys](https://nodecode.ai/account/keys)
(it starts with `sk-nc-` and is shown once), then top up a balance at
[nodecode.ai/account/top-up](https://nodecode.ai/account/top-up). Calls are
paid per token from that balance.

Install the plugin:

```bash
openclaw plugins install @openclaw/nodecode-provider
```

Installation applies to a running Gateway automatically; otherwise it takes effect
on the next startup. See [Apply changes and inspect](/plugins/manage-plugins#apply-changes-and-inspect).

Run onboarding:

```bash
openclaw onboard --auth-choice nodecode-api-key
```

For non-interactive setup:

```bash
openclaw onboard --non-interactive --accept-risk --skip-health \
  --mode local \
  --auth-choice nodecode-api-key \
  --nodecode-api-key "$NODECODE_API_KEY"
```

Or expose the key to the Gateway process:

```bash
export NODECODE_API_KEY="example-nodecode-key-not-real"
```

Verify the provider:

```bash
openclaw models list --provider nodecode
```

## Models

The setup default is **Cyber v1**, with a 1,048,576-token context window and
text input. Its onboarding alias is `Cyber v1`. Use the model id after the
`nodecode/` provider prefix. Maximum output includes reasoning tokens.

| Model id            | Name     | Context   | Max output | Input | Native reasoning modes                                     |
| ------------------- | -------- | --------- | ---------- | ----- | ---------------------------------------------------------- |
| `nodecode-cyber-v1` | Cyber v1 | 1,048,576 | 131,072    | Text  | `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` |

The plugin lists the models your key can call from `GET /v1/models` and adds
the catalog metadata above to Cyber v1. That list can also name Nodecode's
non-chat models, such as Decide v1 and Image v1; they stay out of the default
model picker.

Catalog prices are USD per million tokens. A balance held in euros pays the
same numbers in euros.

| Model id            | Input | Output | Cache read | Cache write |
| ------------------- | ----- | ------ | ---------- | ----------- |
| `nodecode-cyber-v1` | $0.33 | $1.32  | $0.009     | $0          |

These are weekday prices. From Friday 00:00 to Monday 00:00 Amsterdam time
every token costs half. A request with more than 262,144 input tokens pays four
times the cache-read price for its cached input. See Nodecode's
[pricing](https://nodecode.ai/docs/pricing) for current rates.

## Thinking levels

OpenClaw sends the selected level unchanged in the top-level Chat Completions
`reasoning_effort` field; `off` sends `none`, which turns reasoning off.

| Model    | OpenClaw level → native effort                                                                                               |
| -------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Cyber v1 | `off` → `none`, `minimal` → `minimal`, `low` → `low`, `medium` → `medium`, `high` → `high`, `xhigh` → `xhigh`, `max` → `max` |

Reasoning arrives before the visible answer and consumes the output budget, so
allow enough output tokens for both. A call that spends its whole budget
reasoning ends with an empty answer and `finish_reason: "length"`. See
[Thinking modes](/tools/thinking).

## Prompt caching

Nodecode caches prompts automatically. Requests with the same
`prompt_cache_key` are routed to the same machine, so OpenClaw's per-session
`prompt_cache_key` keeps each session on its cache; it does not guarantee a
hit. Cached input is billed at the cache-read price, and there is no
cache-write premium. The plugin does not send `prompt_cache_retention`.

Requests are stateless; the plugin does not send `store`. Streaming usage
includes cached input and reasoning-token counts.

## Tools

Cyber v1 supports tool calling through Chat Completions. It takes text input
only.

## Troubleshooting

- `401`: confirm the key is visible to the Gateway process and has not been
  revoked, or run onboarding again.
- `402`: the balance is used up. Top it up at
  [nodecode.ai/account/top-up](https://nodecode.ai/account/top-up).
- `403` with a free key: free keys serve only the Nodecode CLI. Use a key with a
  topped-up balance.
- `429`: all of the account's concurrent requests are busy. A refused call costs
  nothing; retry, or run fewer agents at once.
- Missing provider: install `@openclaw/nodecode-provider` and check
  `openclaw plugins list` before selecting a model.
- No visible answer or an output-limit stop: increase the output budget or choose
  a lower thinking level.
- Managed Gateway cannot see the key: put it in `~/.openclaw/.env` or another
  trusted environment source loaded by the service. See [Environment
  variables](/help/environment).

## Related

- [Model providers](/concepts/model-providers)
- [All providers](/providers/index)
- [Thinking modes](/tools/thinking)
