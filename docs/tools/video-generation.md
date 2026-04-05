---
summary: "Generate videos using configured providers such as Qwen"
read_when:
  - Generating videos via the agent
  - Configuring video generation providers and models
  - Understanding the video_generate tool parameters
title: "Video Generation"
---

# Video Generation

The `video_generate` tool lets the agent create videos using your configured providers. Generated videos are delivered automatically as media attachments in the agent's reply.

<Note>
The tool only appears when at least one video-generation provider is available. If you don't see `video_generate` in your agent's tools, configure `agents.defaults.videoGenerationModel` or set up a provider API key.
</Note>

## Quick start

1. Set an API key for at least one provider (for example `QWEN_API_KEY`).
2. Optionally set your preferred model:

```json5
{
  agents: {
    defaults: {
      videoGenerationModel: "qwen/wan2.6-t2v",
    },
  },
}
```

3. Ask the agent: _"Generate a 5-second cinematic video of a friendly lobster surfing at sunset."_

The agent calls `video_generate` automatically. No tool allow-listing needed — it's enabled by default when a provider is available.

## Supported providers

| Provider | Default model | Reference inputs | API key                                                    |
| -------- | ------------- | ---------------- | ---------------------------------------------------------- |
| Qwen     | `wan2.6-t2v`  | Yes, remote URLs | `QWEN_API_KEY`, `MODELSTUDIO_API_KEY`, `DASHSCOPE_API_KEY` |

Use `action: "list"` to inspect available providers and models at runtime:

```
/tool video_generate action=list
```

## Tool parameters

| Parameter         | Type     | Description                                                                           |
| ----------------- | -------- | ------------------------------------------------------------------------------------- |
| `prompt`          | string   | Video generation prompt (required for `action: "generate"`)                           |
| `action`          | string   | `"generate"` (default) or `"list"` to inspect providers                               |
| `model`           | string   | Provider/model override, e.g. `qwen/wan2.6-t2v`                                       |
| `image`           | string   | Single reference image path or URL                                                    |
| `images`          | string[] | Multiple reference images (up to 5)                                                   |
| `video`           | string   | Single reference video path or URL                                                    |
| `videos`          | string[] | Multiple reference videos (up to 4)                                                   |
| `size`            | string   | Size hint when the provider supports it                                               |
| `aspectRatio`     | string   | Aspect ratio: `1:1`, `2:3`, `3:2`, `3:4`, `4:3`, `4:5`, `5:4`, `9:16`, `16:9`, `21:9` |
| `resolution`      | string   | Resolution hint: `480P`, `720P`, or `1080P`                                           |
| `durationSeconds` | number   | Target duration in seconds                                                            |
| `audio`           | boolean  | Enable generated audio when the provider supports it                                  |
| `watermark`       | boolean  | Toggle provider watermarking when supported                                           |
| `filename`        | string   | Output filename hint                                                                  |

Not all providers support all parameters. The tool validates provider capability limits before it submits the request.

## Configuration

### Model selection

```json5
{
  agents: {
    defaults: {
      videoGenerationModel: {
        primary: "qwen/wan2.6-t2v",
        fallbacks: ["qwen/wan2.6-r2v-flash"],
      },
    },
  },
}
```

### Provider selection order

When generating a video, OpenClaw tries providers in this order:

1. **`model` parameter** from the tool call (if the agent specifies one)
2. **`videoGenerationModel.primary`** from config
3. **`videoGenerationModel.fallbacks`** in order
4. **Auto-detection** — uses auth-backed provider defaults only:
   - current default provider first
   - remaining registered video-generation providers in provider-id order

If a provider fails, the next candidate is tried automatically. If all fail, the error includes details from each attempt.

## Qwen reference inputs

The bundled Qwen provider supports text-to-video plus image/video reference modes, but the upstream DashScope video endpoint currently requires **remote http(s) URLs** for reference inputs. Local file paths and uploaded buffers are rejected up front instead of being silently ignored.

## Related

- [Tools Overview](/tools) — all available agent tools
- [Qwen](/providers/qwen) — Qwen-specific setup and limits
- [Configuration Reference](/gateway/configuration-reference#agent-defaults) — `videoGenerationModel` config
- [Models](/concepts/models) — model configuration and failover
