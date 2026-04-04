title: "Qwen / Model Studio"
summary: "Endpoint detail for the bundled qwen provider and its legacy modelstudio compatibility surface"
read_when:

- You want endpoint-level detail for Qwen Cloud / Alibaba DashScope
- You need the env var compatibility story for the qwen provider
- You want to use the Standard (pay-as-you-go) or Coding Plan endpoint

---

# Qwen / Model Studio (Alibaba Cloud)

This page documents the endpoint mapping behind OpenClaw's bundled `qwen`
provider. The provider keeps `modelstudio` provider ids, auth-choice ids, and
model refs working as compatibility aliases while `qwen` becomes the canonical
surface.

<Info>

If you need **`qwen3.6-plus`**, prefer **Standard (pay-as-you-go)**. Coding
Plan availability can lag behind the public Model Studio catalog, and the
Coding Plan API can reject a model until it appears in your plan's supported
model list.

</Info>

- Provider: `qwen` (legacy alias: `modelstudio`)
- Auth: `QWEN_API_KEY`
- Also accepted: `MODELSTUDIO_API_KEY`, `DASHSCOPE_API_KEY`
- API: OpenAI-compatible

## Quick start

### Standard (pay-as-you-go)

```bash
# China endpoint
openclaw onboard --auth-choice qwen-standard-api-key-cn

# Global/Intl endpoint
openclaw onboard --auth-choice qwen-standard-api-key
```

### Coding Plan (subscription)

```bash
# China endpoint
openclaw onboard --auth-choice qwen-api-key-cn

# Global/Intl endpoint
openclaw onboard --auth-choice qwen-api-key
```

Legacy `modelstudio-*` auth-choice ids still work as compatibility aliases, but
the canonical onboarding ids are the `qwen-*` choices shown above.

After onboarding, set a default model:

```json5
{
  agents: {
    defaults: {
      model: { primary: "qwen/qwen3.5-plus" },
    },
  },
}
```

## Plan types and endpoints

| Plan                       | Region | Auth choice                | Endpoint                                         |
| -------------------------- | ------ | -------------------------- | ------------------------------------------------ |
| Standard (pay-as-you-go)   | China  | `qwen-standard-api-key-cn` | `dashscope.aliyuncs.com/compatible-mode/v1`      |
| Standard (pay-as-you-go)   | Global | `qwen-standard-api-key`    | `dashscope-intl.aliyuncs.com/compatible-mode/v1` |
| Coding Plan (subscription) | China  | `qwen-api-key-cn`          | `coding.dashscope.aliyuncs.com/v1`               |
| Coding Plan (subscription) | Global | `qwen-api-key`             | `coding-intl.dashscope.aliyuncs.com/v1`          |

The provider auto-selects the endpoint based on your auth choice. Canonical
choices use the `qwen-*` family; `modelstudio-*` remains compatibility-only.
You can
override with a custom `baseUrl` in config.

Native Model Studio endpoints advertise streaming usage compatibility on the
shared `openai-completions` transport. OpenClaw keys that off endpoint
capabilities now, so DashScope-compatible custom provider ids targeting the
same native hosts inherit the same streaming-usage behavior instead of
requiring the built-in `qwen` provider id specifically.

## Get your API key

- **Manage keys**: [home.qwencloud.com/api-keys](https://home.qwencloud.com/api-keys)
- **Docs**: [docs.qwencloud.com](https://docs.qwencloud.com/developer-guides/getting-started/introduction)

## Built-in catalog

OpenClaw currently ships this bundled Qwen catalog:

| Model ref                   | Input       | Context   | Notes                                              |
| --------------------------- | ----------- | --------- | -------------------------------------------------- |
| `qwen/qwen3.5-plus`         | text, image | 1,000,000 | Default model                                      |
| `qwen/qwen3.6-plus`         | text, image | 1,000,000 | Prefer Standard endpoints when you need this model |
| `qwen/qwen3-max-2026-01-23` | text        | 262,144   | Qwen Max line                                      |
| `qwen/qwen3-coder-next`     | text        | 262,144   | Coding                                             |
| `qwen/qwen3-coder-plus`     | text        | 1,000,000 | Coding                                             |
| `qwen/MiniMax-M2.5`         | text        | 1,000,000 | Reasoning enabled                                  |
| `qwen/glm-5`                | text        | 202,752   | GLM                                                |
| `qwen/glm-4.7`              | text        | 202,752   | GLM                                                |
| `qwen/kimi-k2.5`            | text, image | 262,144   | Moonshot AI via Alibaba                            |

Availability can still vary by endpoint and billing plan even when a model is
present in the bundled catalog.

Native-streaming usage compatibility applies to both the Coding Plan hosts and
the Standard DashScope-compatible hosts:

- `https://coding.dashscope.aliyuncs.com/v1`
- `https://coding-intl.dashscope.aliyuncs.com/v1`
- `https://dashscope.aliyuncs.com/compatible-mode/v1`
- `https://dashscope-intl.aliyuncs.com/compatible-mode/v1`

## Qwen 3.6 Plus availability

`qwen3.6-plus` is available on the Standard (pay-as-you-go) Model Studio
endpoints:

- China: `dashscope.aliyuncs.com/compatible-mode/v1`
- Global: `dashscope-intl.aliyuncs.com/compatible-mode/v1`

If the Coding Plan endpoints return an "unsupported model" error for
`qwen3.6-plus`, switch to Standard (pay-as-you-go) instead of the Coding Plan
endpoint/key pair.

## Environment note

If the Gateway runs as a daemon (launchd/systemd), make sure
`QWEN_API_KEY` is available to that process (for example, in
`~/.openclaw/.env` or via `env.shellEnv`).
