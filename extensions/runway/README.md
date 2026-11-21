# Runway

Generate or transform videos with Runway's hosted models. The plugin supports
text-to-video, image-to-video, and video-to-video through OpenClaw's shared video
generation feature.

## Get started

Add a Runway API key:

```bash
openclaw onboard --auth-choice runway-api-key
```

The Gateway also accepts `RUNWAYML_API_SECRET` or `RUNWAY_API_KEY`. Select a
Runway model under `agents.defaults.mediaModels.video`, then ask your agent to
generate a video.

Choose a model that supports your input mode. Local or remote reference inputs
are supported, but video editing requires a video-to-video model.

See the [Runway guide](https://docs.openclaw.ai/providers/runway) for supported
models, reference inputs, and output controls.
