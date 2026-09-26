# Alibaba Model Studio

Generate videos with Wan models on Alibaba Model Studio. The plugin supplies
text-to-video, image-to-video, and reference-to-video capabilities through
OpenClaw's shared video generation feature.

## Get started

Add your Model Studio API key:

```bash
openclaw onboard --auth-choice alibaba-model-studio-api-key
```

The Gateway also accepts `MODELSTUDIO_API_KEY`, `DASHSCOPE_API_KEY`, or
`QWEN_API_KEY`. Select an `alibaba/` video model under
`agents.defaults.mediaModels.video`.

Choose a model matching the intended input mode. Reference images and videos
must be reachable HTTP or HTTPS URLs. Qwen chat models belong to the separate
Qwen plugin.

See the [Alibaba Model Studio guide](https://docs.openclaw.ai/providers/alibaba)
for model-specific inputs and regional endpoints.
