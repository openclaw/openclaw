---
summary: "Generate videos using configured providers such as Alibaba, OpenAI, Google, Qwen, MiniMax, and Runway"
read_when:
  - Generating videos via the agent
  - Configuring video generation providers and models
  - Understanding the video_generate tool parameters
title: "Video Generation"
---

# Video Generation

The `video_generate` tool lets the agent create videos using your configured providers. In agent sessions, OpenClaw starts video generation as a background task, tracks it in the task ledger, then wakes the agent again when the clip is ready so the agent can post the finished video back into the original channel.

<Note>
The tool only appears when at least one video-generation provider is available. If you don't see `video_generate` in your agent's tools, configure `agents.defaults.videoGenerationModel` or set up a provider API key.
</Note>

<Note>
In agent sessions, `video_generate` returns immediately with a task id/run id. The actual provider job continues in the background. When it finishes, OpenClaw wakes the same session with an internal completion event so the agent can send a normal follow-up plus the generated video attachment.
</Note>

## Quick start

1. Set an API key for at least one provider (for example `OPENAI_API_KEY`, `GEMINI_API_KEY`, `MODELSTUDIO_API_KEY`, `QWEN_API_KEY`, or `RUNWAYML_API_SECRET`).
2. Optionally set your preferred model:

```json5
{
  agents: {
    defaults: {
      videoGenerationModel: {
        primary: "qwen/wan2.6-t2v",
      },
    },
  },
}
```

3. Ask the agent: _"Generate a 5-second cinematic video of a friendly lobster surfing at sunset."_

The agent calls `video_generate` automatically. No tool allow-listing needed — it's enabled by default when a provider is available.

For direct synchronous contexts without a session-backed agent run, the tool still falls back to inline generation and returns the final media path in the tool result.

## Supported providers

| Provider | Default model                   | Reference inputs   | API key                                                    |
| -------- | ------------------------------- | ------------------ | ---------------------------------------------------------- |
| Alibaba  | `wan2.6-t2v`                    | Yes, remote URLs   | `MODELSTUDIO_API_KEY`, `DASHSCOPE_API_KEY`, `QWEN_API_KEY` |
| BytePlus | `seedance-1-0-lite-t2v-250428`  | 1 image            | `BYTEPLUS_API_KEY`                                         |
| fal      | `fal-ai/minimax/video-01-live`  | 1 image            | `FAL_KEY`                                                  |
| Google   | `veo-3.1-fast-generate-preview` | 1 image or 1 video | `GEMINI_API_KEY`, `GOOGLE_API_KEY`                         |
| MiniMax  | `MiniMax-Hailuo-2.3`            | 1 image            | `MINIMAX_API_KEY`                                          |
| OpenAI   | `sora-2`                        | 1 image or 1 video | `OPENAI_API_KEY`                                           |
| Qwen     | `wan2.6-t2v`                    | Yes, remote URLs   | `QWEN_API_KEY`, `MODELSTUDIO_API_KEY`, `DASHSCOPE_API_KEY` |
| Runway   | `gen4.5`                        | 1 image or 1 video | `RUNWAYML_API_SECRET`, `RUNWAY_API_KEY`                    |
| Together | `Wan-AI/Wan2.2-T2V-A14B`        | 1 image            | `TOGETHER_API_KEY`                                         |
| xAI      | `grok-imagine-video`            | 1 image or 1 video | `XAI_API_KEY`                                              |

Use `action: "list"` to inspect available providers and models at runtime:

```
/tool video_generate action=list
```

## Tool parameters

| Parameter         | Type     | Description                                                                            |
| ----------------- | -------- | -------------------------------------------------------------------------------------- |
| `prompt`          | string   | Video generation prompt (required for `action: "generate"`)                            |
| `action`          | string   | `"generate"` (default) or `"list"` to inspect providers                                |
| `model`           | string   | Provider/model override, e.g. `qwen/wan2.6-t2v`                                        |
| `image`           | string   | Single reference image path or URL                                                     |
| `images`          | string[] | Multiple reference images (up to 5)                                                    |
| `video`           | string   | Single reference video path or URL                                                     |
| `videos`          | string[] | Multiple reference videos (up to 4)                                                    |
| `size`            | string   | Size hint when the provider supports it                                                |
| `aspectRatio`     | string   | Aspect ratio: `1:1`, `2:3`, `3:2`, `3:4`, `4:3`, `4:5`, `5:4`, `9:16`, `16:9`, `21:9`  |
| `resolution`      | string   | Resolution hint: `480P`, `720P`, or `1080P`                                            |
| `durationSeconds` | number   | Target duration in seconds. OpenClaw may round to the nearest provider-supported value |
| `audio`           | boolean  | Enable generated audio when the provider supports it                                   |
| `watermark`       | boolean  | Toggle provider watermarking when supported                                            |
| `filename`        | string   | Output filename hint                                                                   |

Not all providers support all parameters. The tool validates provider capability limits before it submits the request. When a provider or model only supports a discrete set of video lengths, OpenClaw rounds `durationSeconds` to the nearest supported value and reports the normalized duration in the tool result.

## Async behavior

- Session-backed agent runs: `video_generate` creates a background task, returns a started/task response immediately, and posts the finished video later in a follow-up agent message.
- Task tracking: use `openclaw tasks list` / `openclaw tasks show <taskId>` to inspect queued, running, and terminal status for the generation.
- Completion wake: OpenClaw injects an internal completion event back into the same session so the model can write the user-facing follow-up itself.
- No-session fallback: direct/local contexts without a real agent session still run inline and return the final video result in the same turn.

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

## Provider notes

- Alibaba uses the DashScope / Model Studio async video endpoint and currently requires remote `http(s)` URLs for reference assets.
- Google uses Gemini/Veo and supports a single image or video reference input.
- MiniMax, Together, BytePlus, and fal currently support a single image reference input.
- OpenAI uses the native video endpoint and currently defaults to `sora-2`.
- Qwen supports image/video references, but the upstream DashScope video endpoint currently requires remote `http(s)` URLs for those references.
- Runway uses the native async task API with `GET /v1/tasks/{id}` polling and currently defaults to `gen4.5`.
- xAI uses the native xAI video API and supports text-to-video, image-to-video, and remote video edit/extend flows.
- fal uses the queue-backed fal video flow for long-running jobs instead of a single blocking inference request.

## Qwen reference inputs

The bundled Qwen provider supports text-to-video plus image/video reference modes, but the upstream DashScope video endpoint currently requires **remote http(s) URLs** for reference inputs. Local file paths and uploaded buffers are rejected up front instead of being silently ignored.

## Related

- [Tools Overview](/tools) — all available agent tools
- [Background Tasks](/automation/tasks) — task tracking for detached `video_generate` runs
- [Alibaba Model Studio](/providers/alibaba) — direct Wan provider setup
- [Google (Gemini)](/providers/google) — Veo provider setup
- [MiniMax](/providers/minimax) — Hailuo provider setup
- [OpenAI](/providers/openai) — Sora provider setup
- [Qwen](/providers/qwen) — Qwen-specific setup and limits
- [Runway](/providers/runway) — Runway setup and current model/input notes
- [Together AI](/providers/together) — Together Wan provider setup
- [xAI](/providers/xai) — Grok video provider setup
- [Configuration Reference](/gateway/configuration-reference#agent-defaults) — `videoGenerationModel` config
- [Models](/concepts/models) — model configuration and failover
