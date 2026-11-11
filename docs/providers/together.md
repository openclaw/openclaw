---
summary: "Together AI setup (auth + model selection)"
title: "Together AI"
read_when:
  - You want to use Together AI with OpenClaw
  - You need the API key env var or CLI auth choice
---

[Together AI](https://together.ai) provides access to leading open-source
models including Llama, DeepSeek, Kimi, and more through a unified API.
OpenClaw bundles it as the `together` provider.

| Property | Value                            |
| -------- | -------------------------------- |
| Provider | `together` (alias: `togetherai`) |
| Auth     | `TOGETHER_API_KEY`               |
| API      | OpenAI-compatible                |
| Base URL | `https://api.together.xyz/v1`    |

## Getting started

<Steps>
  <Step title="Get an API key">
    Create an API key at
    [api.together.ai/settings/api-keys](https://api.together.ai/settings/api-keys).
  </Step>
  <Step title="Run onboarding">
    ```bash
    openclaw onboard --auth-choice together-api-key
    ```
  </Step>
  <Step title="Set a default model">
    ```json5
    {
      agents: {
        defaults: {
          model: {
            primary: "together/zai-org/GLM-5.2",
          },
        },
      },
    }
    ```
  </Step>
</Steps>

### Non-interactive example

```bash
openclaw onboard --non-interactive --accept-risk --skip-health \
  --mode local \
  --auth-choice together-api-key \
  --together-api-key "$TOGETHER_API_KEY"
```

<Note>
Onboarding sets `together/zai-org/GLM-5.2` as the default chat model.
</Note>

## Built-in catalog

Cost is USD per million tokens.

| Model ref                                          | Name                         | Input | Context | Max output | Cost (in/out) | Notes         |
| -------------------------------------------------- | ---------------------------- | ----- | ------- | ---------- | ------------- | ------------- |
| `together/meta-llama/Llama-3.3-70B-Instruct-Turbo` | Llama 3.3 70B Instruct Turbo | text  | 131,072 | 8,192      | 1.04 / 1.04   | General model |
| `together/zai-org/GLM-5.2`                         | GLM 5.2 FP4                  | text  | 262,144 | 131,072    | 1.40 / 4.40   | Default model |

## Video generation

The bundled `together` plugin also registers video generation through the
shared `video_generate` tool.

| Property             | Value                                                                                  |
| -------------------- | -------------------------------------------------------------------------------------- |
| Default video model  | `Wan-AI/wan2.7-t2v`                                                                    |
| Other models         | `Wan-AI/wan2.7-i2v`, `minimax/hailuo-02`                                               |
| Modes                | text-to-video; image-to-video only with `Wan-AI/wan2.7-i2v` (single first-frame image) |
| Duration             | Wan 2.7: 2-10 seconds in OpenClaw; Hailuo duration support is model-specific           |
| Supported parameters | `size` (see below); `aspectRatio`/`resolution` are not read                            |

For Wan 2.7, OpenClaw translates `size` into Together's `resolution` and `ratio`
fields. Supported sizes follow [Together's Wan 2.7 guide](https://docs.together.ai/docs/wan2.7-quickstart):

| Aspect ratio | 720P size  | 1080P size  |
| ------------ | ---------- | ----------- |
| 16:9         | `1280x720` | `1920x1080` |
| 9:16         | `720x1280` | `1080x1920` |
| 1:1          | `960x960`  | `1440x1440` |
| 4:3          | `1104x832` | `1648x1248` |
| 3:4          | `832x1104` | `1248x1648` |

Other Wan sizes are rejected before submission. Omit `size` to use Together's
defaults. Hailuo continues to receive pixel `width` and `height` from `size`.
Wan image input is sent as `media.frame_images` with `frame: "first"`, not as a
style reference in `media.reference_images`.

To use Together as the default video provider:

```json5
{
  agents: {
    defaults: {
      mediaModels: {
        video: {
          primary: "together/Wan-AI/wan2.7-t2v",
        },
      },
    },
  },
}
```

<Tip>
See [Video generation](/tools/video-generation) for the shared tool parameters,
provider selection, and failover behavior.
</Tip>

## Prompt caching

Together automatically reuses matching prompt prefixes. OpenClaw sends a stable
`prompt_cache_key` on native Together requests to improve routing across turns.
Cache usage is read from both `usage.prompt_tokens_details.cached_tokens` and
`usage.cached_tokens`, depending on the model's response format. Keep the model,
tool definitions, reasoning settings, and earlier messages stable for the best
reuse. See [Together prompt caching](https://docs.together.ai/docs/inference/chat/prompt-caching).

<AccordionGroup>
  <Accordion title="Environment note">
    If the Gateway runs as a daemon (launchd/systemd), make sure
    `TOGETHER_API_KEY` is available to that process (for example, in
    `~/.openclaw/.env` or via `env.shellEnv`).

    <Warning>
    Keys set only in your interactive shell are not visible to daemon-managed
    gateway processes. Use `~/.openclaw/.env` or `env.shellEnv` config for
    persistent availability.
    </Warning>

  </Accordion>

  <Accordion title="Troubleshooting">
    - Verify your key works: `openclaw models list --provider together`
    - If models are not appearing, confirm the API key is set in the correct
      environment for your Gateway process.
    - Model refs use the form `together/<model-id>`.

  </Accordion>
</AccordionGroup>

## Related

<CardGroup cols={2}>
  <Card title="Model providers" href="/concepts/model-providers" icon="layers">
    Provider rules, model refs, and failover behavior.
  </Card>
  <Card title="Video generation" href="/tools/video-generation" icon="video">
    Shared video generation tool parameters and provider selection.
  </Card>
  <Card title="Configuration reference" href="/gateway/configuration-reference" icon="gear">
    Full config schema including provider settings.
  </Card>
  <Card title="Together AI" href="https://together.ai" icon="arrow-up-right-from-square">
    Together AI dashboard, API docs, and pricing.
  </Card>
</CardGroup>
