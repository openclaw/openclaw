# Together AI

Use Together AI's hosted chat models and video generation in OpenClaw. The
plugin connects to Together's API and supplies models for agent conversations
and the shared video generation feature.

## Get started

Create a Together API key, then run:

```bash
openclaw onboard --auth-choice together-api-key
```

You can also provide `TOGETHER_API_KEY` in the Gateway's environment. Browse chat
models with `openclaw models list --provider together`.

For video, set your preferred Together model under
`agents.defaults.mediaModels.video`. Text-to-video and image-to-video support
depend on the selected model.

See the [Together AI guide](https://docs.openclaw.ai/providers/together) for model
selection and supported video inputs.
