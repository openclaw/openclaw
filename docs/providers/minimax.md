---
summary: "Use MiniMax models in OpenClaw"
read_when:
  - You want MiniMax models in OpenClaw
  - You need MiniMax setup guidance
title: "MiniMax"
---

# MiniMax

OpenClaw's MiniMax provider defaults to **MiniMax M2.7**.

## Model lineup

- `MiniMax-M2.7`: default hosted reasoning model.
- `MiniMax-M2.7-highspeed`: faster M2.7 reasoning tier.
- `image-01`: image generation model (generate and image-to-image editing).

## Image generation

The MiniMax plugin registers the `image-01` model for the `image_generate` tool. It supports:

- **Text-to-image generation** with aspect ratio control.
- **Image-to-image editing** (subject reference) with aspect ratio control.
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

When onboarding or API-key setup writes explicit `models.providers.minimax`
entries, OpenClaw materializes `MiniMax-M2.7` and
`MiniMax-M2.7-highspeed` with `input: ["text", "image"]`.

The bundled MiniMax provider catalog itself currently advertises those chat
refs as text-only metadata until explicit provider config is materialized.

## Choose a setup

### MiniMax OAuth (Coding Plan) - recommended

**Best for:** quick setup with MiniMax Coding Plan via OAuth, no API key required.

Enable the bundled OAuth plugin and authenticate:

```bash
openclaw plugins enable minimax  # skip if already loaded.
openclaw gateway restart  # restart if gateway is already running
openclaw onboard --auth-choice minimax-portal
```

You will be prompted to select an endpoint:

- **Global** - International users (`api.minimax.io`)
- **CN** - Users in China (`api.minimaxi.com`)

See the MiniMax plugin package README in the OpenClaw repo for details.

### MiniMax M2.7 (API key)

**Best for:** hosted MiniMax with Anthropic-compatible API.

Configure via CLI:

- Run `openclaw configure`
- Select **Model/auth**
- Choose a **MiniMax** auth option

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
- Onboarding and direct API-key setup write explicit model definitions with
  `input: ["text", "image"]` for both M2.7 variants
- The bundled provider catalog currently exposes the chat refs as text-only
  metadata until explicit MiniMax provider config exists
- Coding Plan usage API: `https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains` (requires a coding plan key).
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
