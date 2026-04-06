---
summary: "Generate and edit images using configured providers (OpenAI, Google Gemini, fal, MiniMax, ComfyUI, Vydra)"
read_when:
  - Generating images via the agent
  - Configuring image generation providers and models
  - Understanding the image_generate tool parameters
title: "Image Generation"
---

# Image Generation

The `image_generate` tool lets the agent create and edit images using your configured providers. Generated images are delivered automatically as media attachments in the agent's reply.

<Note>
The tool only appears when at least one image generation provider is available. If you don't see `image_generate` in your agent's tools, configure `agents.defaults.imageGenerationModel` or set up a provider API key.
</Note>

## Quick start

1. Set an API key for at least one provider (for example `OPENAI_API_KEY` or `GEMINI_API_KEY`).
2. Optionally set your preferred model:

```json5
{
  agents: {
    defaults: {
      imageGenerationModel: {
        primary: "openai/gpt-image-1",
      },
    },
  },
}
```

3. Ask the agent: _"Generate an image of a friendly lobster mascot."_

The agent calls `image_generate` automatically. No tool allow-listing needed — it's enabled by default when a provider is available.

## Supported providers

| Provider | Default model                    | Edit support                       | API key                                               |
| -------- | -------------------------------- | ---------------------------------- | ----------------------------------------------------- |
| OpenAI   | `gpt-image-1`                    | Yes (up to 5 images)               | `OPENAI_API_KEY`                                      |
| Google   | `gemini-3.1-flash-image-preview` | Yes                                | `GEMINI_API_KEY` or `GOOGLE_API_KEY`                  |
| fal      | `fal-ai/flux/dev`                | Yes                                | `FAL_KEY`                                             |
| MiniMax  | `image-01`                       | Yes (subject reference)            | `MINIMAX_API_KEY` or MiniMax OAuth (`minimax-portal`) |
| ComfyUI  | `workflow`                       | Yes (1 image, workflow-configured) | `COMFY_API_KEY` or `COMFY_CLOUD_API_KEY` for cloud    |
| Vydra    | `grok-imagine`                   | No                                 | `VYDRA_API_KEY`                                       |

Use `action: "list"` to inspect available providers and models at runtime:

```
/tool image_generate action=list
```

## Tool parameters

| Parameter     | Type     | Description                                                                           |
| ------------- | -------- | ------------------------------------------------------------------------------------- |
| `prompt`      | string   | Image generation prompt (required for `action: "generate"`)                           |
| `action`      | string   | `"generate"` (default) or `"list"` to inspect providers                               |
| `model`       | string   | Provider/model override, e.g. `openai/gpt-image-1`                                    |
| `image`       | string   | Single reference image path or URL for edit mode                                      |
| `images`      | string[] | Multiple reference images for edit mode (up to 5)                                     |
| `size`        | string   | Size hint: `1024x1024`, `1536x1024`, `1024x1536`, `1024x1792`, `1792x1024`            |
| `aspectRatio` | string   | Aspect ratio: `1:1`, `2:3`, `3:2`, `3:4`, `4:3`, `4:5`, `5:4`, `9:16`, `16:9`, `21:9` |
| `resolution`  | string   | Resolution hint: `1K`, `2K`, or `4K`                                                  |
| `count`       | number   | Number of images to generate (1–4)                                                    |
| `filename`    | string   | Output filename hint                                                                  |

Not all providers support all parameters. The tool passes what each provider supports, ignores the rest, and reports dropped overrides in the tool result.

## Configuration

### Model selection

```json5
{
  agents: {
    defaults: {
      imageGenerationModel: {
        primary: "openai/gpt-image-1",
        fallbacks: ["google/gemini-3.1-flash-image-preview", "fal/fal-ai/flux/dev"],
      },
    },
  },
}
```

### Provider selection order

When generating an image, OpenClaw tries providers in this order:

1. **`model` parameter** from the tool call (if the agent specifies one)
2. **`imageGenerationModel.primary`** from config
3. **`imageGenerationModel.fallbacks`** in order
4. **Auto-detection** — uses auth-backed provider defaults only:
   - current default provider first
   - remaining registered image-generation providers in provider-id order

If a provider fails (auth error, rate limit, etc.), the next candidate is tried automatically. If all fail, the error includes details from each attempt.

Notes:

- Auto-detection is auth-aware. A provider default only enters the candidate list
  when OpenClaw can actually authenticate that provider.
- Use `action: "list"` to inspect the currently registered providers, their
  default models, and auth env-var hints.

### Image editing

OpenAI, Google, fal, MiniMax, and ComfyUI support editing reference images. Pass a reference image path or URL:

```
"Generate a watercolor version of this photo" + image: "/path/to/photo.jpg"
```

OpenAI and Google support up to 5 reference images via the `images` parameter. fal, MiniMax, and ComfyUI support 1.

MiniMax image generation is available through both bundled MiniMax auth paths:

- `minimax/image-01` for API-key setups
- `minimax-portal/image-01` for OAuth setups

## Provider capabilities

| Capability            | OpenAI               | Google               | fal                 | MiniMax                    | ComfyUI                            | Vydra   |
| --------------------- | -------------------- | -------------------- | ------------------- | -------------------------- | ---------------------------------- | ------- |
| Generate              | Yes (up to 4)        | Yes (up to 4)        | Yes (up to 4)       | Yes (up to 9)              | Yes (workflow-defined outputs)     | Yes (1) |
| Edit/reference        | Yes (up to 5 images) | Yes (up to 5 images) | Yes (1 image)       | Yes (1 image, subject ref) | Yes (1 image, workflow-configured) | No      |
| Size control          | Yes                  | Yes                  | Yes                 | No                         | No                                 | No      |
| Aspect ratio          | No                   | Yes                  | Yes (generate only) | Yes                        | No                                 | No      |
| Resolution (1K/2K/4K) | No                   | Yes                  | Yes                 | No                         | No                                 | No      |

## Related

- [Tools Overview](/tools) — all available agent tools
- [fal](/providers/fal) — fal image and video provider setup
- [ComfyUI](/providers/comfy) — local ComfyUI and Comfy Cloud workflow setup
- [Google (Gemini)](/providers/google) — Gemini image provider setup
- [MiniMax](/providers/minimax) — MiniMax image provider setup
- [OpenAI](/providers/openai) — OpenAI Images provider setup
- [Vydra](/providers/vydra) — Vydra image, video, and speech setup
- [Configuration Reference](/gateway/configuration-reference#agent-defaults) — `imageGenerationModel` config
- [Models](/concepts/models) — model configuration and failover
