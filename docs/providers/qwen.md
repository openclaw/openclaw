summary: "Use Qwen Cloud via OpenClaw's bundled qwen provider"
read_when:

- You want to use Qwen with OpenClaw
- You previously used Qwen OAuth
  title: "Qwen"

---

# Qwen

<Warning>

**Qwen OAuth has been removed.** The free-tier OAuth integration
(`qwen-portal`) that used `portal.qwen.ai` endpoints is no longer available.
See [Issue #49557](https://github.com/openclaw/openclaw/issues/49557) for
background.

</Warning>

## Recommended: Qwen Cloud

OpenClaw now treats Qwen as a first-class bundled provider with canonical id
`qwen`. The bundled provider targets the Qwen Cloud / Alibaba DashScope and
Coding Plan endpoints and keeps legacy `modelstudio` ids working as a
compatibility alias.

- Provider: `qwen`
- Preferred env var: `QWEN_API_KEY`
- Also accepted for compatibility: `MODELSTUDIO_API_KEY`, `DASHSCOPE_API_KEY`
- API style: OpenAI-compatible

If you want `qwen3.6-plus`, prefer the **Standard (pay-as-you-go)** endpoint.
Coding Plan support can lag behind the public catalog.

```bash
# Global Coding Plan endpoint
openclaw onboard --auth-choice qwen-api-key

# China Coding Plan endpoint
openclaw onboard --auth-choice qwen-api-key-cn

# Global Standard (pay-as-you-go) endpoint
openclaw onboard --auth-choice qwen-standard-api-key

# China Standard (pay-as-you-go) endpoint
openclaw onboard --auth-choice qwen-standard-api-key-cn
```

Legacy `modelstudio-*` auth-choice ids and `modelstudio/...` model refs still
work.

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

## Capability plan

The `qwen` extension is being positioned as the vendor home for the full Qwen
Cloud surface, not just coding/text models.

- Text/chat models: bundled now
- Tool calling, structured output, thinking: inherited from the OpenAI-compatible transport
- Image generation: planned at the provider-plugin layer
- Image/video understanding: bundled now on the Standard endpoint
- Speech/audio: planned at the provider-plugin layer
- Memory embeddings/reranking: planned through the embedding adapter surface
- Video generation: bundled now through the shared video-generation capability

## Multimodal add-ons

The `qwen` extension now also exposes:

- Video understanding via `qwen-vl-max-latest`
- Wan video generation via:
  - `wan2.6-t2v` (default)
  - `wan2.6-i2v`
  - `wan2.6-r2v`
  - `wan2.6-r2v-flash`
  - `wan2.7-r2v`

These multimodal surfaces use the **Standard** DashScope endpoints, not the
Coding Plan endpoints.

- Global/Intl Standard base URL: `https://dashscope-intl.aliyuncs.com/compatible-mode/v1`
- China Standard base URL: `https://dashscope.aliyuncs.com/compatible-mode/v1`

For video generation, OpenClaw maps the configured Qwen region to the matching
DashScope AIGC host before submitting the job:

- Global/Intl: `https://dashscope-intl.aliyuncs.com`
- China: `https://dashscope.aliyuncs.com`

That means a normal `models.providers.qwen.baseUrl` pointing at either the
Coding Plan or Standard Qwen hosts still keeps video generation on the correct
regional DashScope video endpoint.

For video generation, set a default model explicitly:

```json5
{
  agents: {
    defaults: {
      videoGenerationModel: { primary: "qwen/wan2.6-t2v" },
    },
  },
}
```

Current bundled Qwen video-generation limits:

- Up to **1** output video per request
- Up to **1** input image
- Up to **4** input videos
- Up to **10 seconds** duration
- Supports `size`, `aspectRatio`, `resolution`, `audio`, and `watermark`

See [Qwen / Model Studio](/providers/qwen_modelstudio) for endpoint-level detail
and compatibility notes.
