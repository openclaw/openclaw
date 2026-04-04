---
summary: "Use MiniMax models in OpenClaw"
read_when:
  - You want MiniMax models in OpenClaw
  - You need MiniMax setup guidance
title: "MiniMax"
---

# MiniMax

OpenClaw's MiniMax provider defaults to **MiniMax M2.7**.

MiniMax also provides:

- bundled speech synthesis via T2A v2
- bundled image understanding via `MiniMax-VL-01`
- bundled `web_search` through the MiniMax Coding Plan search API

Provider split:

- `minimax`: API-key text provider, plus bundled image generation, image understanding, speech, and web search
- `minimax-portal`: OAuth text provider, plus bundled image generation and image understanding

## Model lineup

- `MiniMax-M2.7`: default hosted reasoning model.
- `MiniMax-M2.7-highspeed`: faster M2.7 reasoning tier.
- `image-01`: image generation model (generate and image-to-image editing).

## Image generation

The MiniMax plugin registers the `image-01` model for the `image_generate` tool. It supports:

- **Text-to-image generation** with aspect ratio control.
- **Image-to-image editing** (subject reference) with aspect ratio control.
- Up to **9 output images** per request.
- Up to **1 reference image** per edit request.
- Supported aspect ratios: `1:1`, `16:9`, `4:3`, `3:2`, `2:3`, `3:4`, `9:16`, `21:9`.

To use MiniMax for image generation, set it as the image generation provider:

```json5
{
  agents: {
    defaults: {
      imageGenerationModel: { primary: "minimax/image-01" },
    },
  },
}
```

The plugin uses the same `MINIMAX_API_KEY` or OAuth auth as the text models. No additional configuration is needed if MiniMax is already set up.

Both `minimax` and `minimax-portal` register `image_generate` with the same
`image-01` model. API-key setups use `MINIMAX_API_KEY`; OAuth setups can use
the bundled `minimax-portal` auth path instead.

When onboarding or API-key setup writes explicit `models.providers.minimax`
entries, OpenClaw materializes `MiniMax-M2.7` and
`MiniMax-M2.7-highspeed` with `input: ["text", "image"]`.

The built-in bundled MiniMax text catalog itself stays text-only metadata until
that explicit provider config exists. Image understanding is exposed separately
through the plugin-owned `MiniMax-VL-01` media provider.

## Image understanding

The MiniMax plugin registers image understanding separately from the text
catalog:

- `minimax`: default image model `MiniMax-VL-01`
- `minimax-portal`: default image model `MiniMax-VL-01`

That is why automatic media routing can use MiniMax image understanding even
when the bundled text-provider catalog still shows text-only M2.7 chat refs.

## Web search

The MiniMax plugin also registers `web_search` through the MiniMax Coding Plan
search API.

- Provider id: `minimax`
- Structured results: titles, URLs, snippets, related queries
- Preferred env var: `MINIMAX_CODE_PLAN_KEY`
- Accepted env alias: `MINIMAX_CODING_API_KEY`
- Compatibility fallback: `MINIMAX_API_KEY` when it already points at a coding-plan token
- Region reuse: `plugins.entries.minimax.config.webSearch.region`, then `MINIMAX_API_HOST`, then MiniMax provider base URLs
- Search stays on provider id `minimax`; OAuth CN/global setup can still steer region indirectly through `models.providers.minimax-portal.baseUrl`

Config lives under `plugins.entries.minimax.config.webSearch.*`.
See [MiniMax Search](/tools/minimax-search).

## Choose a setup

### MiniMax OAuth (Coding Plan) - recommended

**Best for:** quick setup with MiniMax Coding Plan via OAuth, no API key required.

Authenticate with the explicit regional OAuth choice:

```bash
openclaw onboard --auth-choice minimax-global-oauth
# or
openclaw onboard --auth-choice minimax-cn-oauth
```

Choice mapping:

- `minimax-global-oauth`: International users (`api.minimax.io`)
- `minimax-cn-oauth`: Users in China (`api.minimaxi.com`)

See the MiniMax plugin package README in the OpenClaw repo for details.

### MiniMax M2.7 (API key)

**Best for:** hosted MiniMax with Anthropic-compatible API.

Configure via CLI:

- Interactive onboarding:

```bash
openclaw onboard --auth-choice minimax-global-api
# or
openclaw onboard --auth-choice minimax-cn-api
```

- `minimax-global-api`: International users (`api.minimax.io`)
- `minimax-cn-api`: Users in China (`api.minimaxi.com`)

```json5
{
  env: { MINIMAX_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "minimax/MiniMax-M2.7" } } },
  models: {
    mode: "merge",
    providers: {
      minimax: {
        baseUrl: "https://api.minimax.io/anthropic",
        apiKey: "${MINIMAX_API_KEY}",
        api: "anthropic-messages",
        models: [
          {
            id: "MiniMax-M2.7",
            name: "MiniMax M2.7",
            reasoning: true,
            input: ["text", "image"],
            cost: { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0.375 },
            contextWindow: 204800,
            maxTokens: 131072,
          },
          {
            id: "MiniMax-M2.7-highspeed",
            name: "MiniMax M2.7 Highspeed",
            reasoning: true,
            input: ["text", "image"],
            cost: { input: 0.6, output: 2.4, cacheRead: 0.06, cacheWrite: 0.375 },
            contextWindow: 204800,
            maxTokens: 131072,
          },
        ],
      },
    },
  },
}
```

On the Anthropic-compatible streaming path, OpenClaw now disables MiniMax
thinking by default unless you explicitly set `thinking` yourself. MiniMax's
streaming endpoint emits `reasoning_content` in OpenAI-style delta chunks
instead of native Anthropic thinking blocks, which can leak internal reasoning
into visible output if left enabled implicitly.

### MiniMax M2.7 as fallback (example)

**Best for:** keep your strongest latest-generation model as primary, fail over to MiniMax M2.7.
Example below uses Opus as a concrete primary; swap to your preferred latest-gen primary model.

```json5
{
  env: { MINIMAX_API_KEY: "sk-..." },
  agents: {
    defaults: {
      models: {
        "anthropic/claude-opus-4-6": { alias: "primary" },
        "minimax/MiniMax-M2.7": { alias: "minimax" },
      },
      model: {
        primary: "anthropic/claude-opus-4-6",
        fallbacks: ["minimax/MiniMax-M2.7"],
      },
    },
  },
}
```

## Configure via `openclaw configure`

Use the interactive config wizard to set MiniMax without editing JSON:

1. Run `openclaw configure`.
2. Select **Model/auth**.
3. Choose a **MiniMax** auth option.
4. Pick your default model when prompted.

Current MiniMax auth choices in the wizard/CLI:

- `minimax-global-oauth`
- `minimax-cn-oauth`
- `minimax-global-api`
- `minimax-cn-api`

## Configuration options

- `models.providers.minimax.baseUrl`: prefer `https://api.minimax.io/anthropic` (Anthropic-compatible); `https://api.minimax.io/v1` is optional for OpenAI-compatible payloads.
- `models.providers.minimax.api`: prefer `anthropic-messages`; `openai-completions` is optional for OpenAI-compatible payloads.
- `models.providers.minimax.apiKey`: MiniMax API key (`MINIMAX_API_KEY`).
- `models.providers.minimax.models`: define `id`, `name`, `reasoning`, `contextWindow`, `maxTokens`, `cost`.
- `agents.defaults.models`: alias models you want in the allowlist.
- `models.mode`: keep `merge` if you want to add MiniMax alongside built-ins.

## Notes

- Model refs are `minimax/<model>`.
- Default chat model: `MiniMax-M2.7`
- Alternate chat model: `MiniMax-M2.7-highspeed`
- On `api: "anthropic-messages"`, OpenClaw injects
  `thinking: { type: "disabled" }` unless thinking is already explicitly set in
  params/config.
- `/fast on` or `params.fastMode: true` rewrites `MiniMax-M2.7` to
  `MiniMax-M2.7-highspeed` on the Anthropic-compatible stream path.
- Onboarding and direct API-key setup write explicit model definitions with
  `input: ["text", "image"]` for both M2.7 variants
- The bundled provider catalog currently exposes the chat refs as text-only
  metadata until explicit MiniMax provider config exists
- Coding Plan usage API: `https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains` (requires a coding plan key).
- OpenClaw normalizes MiniMax coding-plan usage to the same `% left` display
  used by other providers. MiniMax's raw `usage_percent` / `usagePercent`
  fields are remaining quota, not consumed quota, so OpenClaw inverts them.
  Count-based fields win when present. When the API returns `model_remains`,
  OpenClaw prefers the chat-model entry, derives the window label from
  `start_time` / `end_time` when needed, and includes the selected model name
  in the plan label so coding-plan windows are easier to distinguish.
- Update pricing values in `models.json` if you need exact cost tracking.
- Referral link for MiniMax Coding Plan (10% off): [https://platform.minimax.io/subscribe/coding-plan?code=DbXJTRClnb&source=link](https://platform.minimax.io/subscribe/coding-plan?code=DbXJTRClnb&source=link)
- See [/concepts/model-providers](/concepts/model-providers) for provider rules.
- Use `openclaw models list` and `openclaw models set minimax/MiniMax-M2.7` to switch.

## Troubleshooting

### "Unknown model: minimax/MiniMax-M2.7"

This usually means the **MiniMax provider isn’t configured** (no provider entry
and no MiniMax auth profile/env key found). A fix for this detection is in
**2026.1.12**. Fix by:

- Upgrading to **2026.1.12** (or run from source `main`), then restarting the gateway.
- Running `openclaw configure` and selecting a **MiniMax** auth option, or
- Adding the `models.providers.minimax` block manually, or
- Setting `MINIMAX_API_KEY` (or a MiniMax auth profile) so the provider can be injected.

Make sure the model id is **case‑sensitive**:

- `minimax/MiniMax-M2.7`
- `minimax/MiniMax-M2.7-highspeed`

Then recheck with:

```bash
openclaw models list
```
