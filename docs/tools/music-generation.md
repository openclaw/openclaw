---
summary: "Generate music with shared providers or plugin-provided workflows"
read_when:
  - Generating music or audio via the agent
  - Configuring music generation providers and models
  - Understanding the music_generate tool parameters
title: "Music Generation"
---

# Music Generation

The `music_generate` tool lets the agent create music or audio through either:

- the shared music-generation capability with configured providers such as Google and MiniMax
- plugin-provided tool surfaces such as a workflow-configured ComfyUI graph

For shared provider-backed agent sessions, OpenClaw starts music generation as a
background task, tracks it in the task ledger, then wakes the agent again when
the track is ready so the agent can post the finished audio back into the
original channel.

<Note>
The built-in shared tool only appears when at least one music-generation provider is available. If you don't see `music_generate` in your agent's tools, configure `agents.defaults.musicGenerationModel` or set up a provider API key.
</Note>

<Note>
Plugin-provided `music_generate` implementations can expose different parameters or runtime behavior. The async task/status flow below applies to the built-in shared provider-backed path.
</Note>

## Quick start

### Shared provider-backed generation

1. Set an API key for at least one provider, for example `GEMINI_API_KEY` or
   `MINIMAX_API_KEY`.
2. Optionally set your preferred model:

```json5
{
  agents: {
    defaults: {
      musicGenerationModel: {
        primary: "google/lyria-3-clip-preview",
      },
    },
  },
}
```

3. Ask the agent: _"Generate an upbeat synthpop track about a night drive
   through a neon city."_

The agent calls `music_generate` automatically. No tool allow-listing needed.

For direct synchronous contexts without a session-backed agent run, the built-in
tool still falls back to inline generation and returns the final media path in
the tool result.

### Workflow-driven plugin generation

The bundled `comfy` plugin can also provide `music_generate` using a
workflow-configured ComfyUI graph.

1. Configure `models.providers.comfy.music` with a workflow JSON and
   prompt/output nodes.
2. If you use Comfy Cloud, set `COMFY_API_KEY` or `COMFY_CLOUD_API_KEY`.
3. Ask the agent for music or call the tool directly.

Example:

```text
/tool music_generate prompt="Warm ambient synth loop with soft tape texture"
```

## Shared bundled provider support

| Provider | Default model          | Reference inputs | Supported controls                                        | API key                            |
| -------- | ---------------------- | ---------------- | --------------------------------------------------------- | ---------------------------------- |
| Google   | `lyria-3-clip-preview` | Up to 10 images  | `lyrics`, `instrumental`, `format`                        | `GEMINI_API_KEY`, `GOOGLE_API_KEY` |
| MiniMax  | `music-2.5+`           | None             | `lyrics`, `instrumental`, `durationSeconds`, `format=mp3` | `MINIMAX_API_KEY`                  |

## Plugin-provided support

| Provider | Model      | Notes                           |
| -------- | ---------- | ------------------------------- |
| ComfyUI  | `workflow` | Workflow-defined music or audio |

Use `action: "list"` to inspect available shared providers and models at
runtime:

```text
/tool music_generate action=list
```

## Built-in tool parameters

| Parameter         | Type     | Description                                                                                       |
| ----------------- | -------- | ------------------------------------------------------------------------------------------------- |
| `prompt`          | string   | Music generation prompt (required for `action: "generate"`)                                       |
| `action`          | string   | `"generate"` (default), `"status"` for the current session task, or `"list"` to inspect providers |
| `model`           | string   | Provider/model override, e.g. `google/lyria-3-pro-preview` or `comfy/workflow`                   |
| `lyrics`          | string   | Optional lyrics when the provider supports explicit lyric input                                   |
| `instrumental`    | boolean  | Request instrumental-only output when the provider supports it                                    |
| `image`           | string   | Single reference image path or URL                                                                |
| `images`          | string[] | Multiple reference images (up to 10)                                                              |
| `durationSeconds` | number   | Target duration in seconds when the provider supports duration hints                              |
| `format`          | string   | Output format hint (`mp3` or `wav`) when the provider supports it                                 |
| `filename`        | string   | Output filename hint                                                                              |

Not all providers or plugins support all parameters. The shared built-in tool
validates provider capability limits before it submits the request.

## Async behavior for the shared provider-backed path

- Session-backed agent runs: `music_generate` creates a background task, returns a started/task response immediately, and posts the finished track later in a follow-up agent message.
- Duplicate prevention: while that background task is still `queued` or `running`, later `music_generate` calls in the same session return task status instead of starting another generation.
- Status lookup: use `action: "status"` to inspect the active session-backed music task without starting a new one.
- Task tracking: use `openclaw tasks list` or `openclaw tasks show <taskId>` to inspect queued, running, and terminal status for the generation.
- Completion wake: OpenClaw injects an internal completion event back into the same session so the model can write the user-facing follow-up itself.
- Prompt hint: later user/manual turns in the same session get a small runtime hint when a music task is already in flight so the model does not blindly call `music_generate` again.
- No-session fallback: direct/local contexts without a real agent session still run inline and return the final audio result in the same turn.

## Configuration

### Model selection

```json5
{
  agents: {
    defaults: {
      musicGenerationModel: {
        primary: "google/lyria-3-clip-preview",
        fallbacks: ["minimax/music-2.5+"],
      },
    },
  },
}
```

### Provider selection order

When generating music, OpenClaw tries providers in this order:

1. `model` parameter from the tool call, if the agent specifies one
2. `musicGenerationModel.primary` from config
3. `musicGenerationModel.fallbacks` in order
4. Auto-detection using auth-backed provider defaults only:
   - current default provider first
   - remaining registered music-generation providers in provider-id order

If a provider fails, the next candidate is tried automatically. If all fail, the
error includes details from each attempt.

## Provider notes

- Google uses Lyria 3 batch generation. The current bundled flow supports
  prompt, optional lyrics text, and optional reference images.
- MiniMax uses the batch `music_generation` endpoint. The current bundled flow
  supports prompt, optional lyrics, instrumental mode, duration steering, and
  mp3 output.
- ComfyUI support is workflow-driven and depends on the configured graph plus
  node mapping for prompt/output fields.

## Live tests

Opt-in live coverage for the shared bundled providers:

```bash
OPENCLAW_LIVE_TEST=1 pnpm test:live -- extensions/music-generation-providers.live.test.ts
```

Opt-in live coverage for the bundled ComfyUI music path:

```bash
OPENCLAW_LIVE_TEST=1 COMFY_LIVE_TEST=1 pnpm test:live -- extensions/comfy/comfy.live.test.ts
```

The Comfy live file also covers comfy image and video workflows when those
sections are configured.

## Related

- [Background Tasks](/automation/tasks) - task tracking for detached `music_generate` runs
- [Configuration Reference](/gateway/configuration-reference#agent-defaults) - `musicGenerationModel` config
- [ComfyUI](/providers/comfy)
- [Google (Gemini)](/providers/google)
- [MiniMax](/providers/minimax)
- [Models](/concepts/models) - model configuration and failover
- [Tools Overview](/tools)
