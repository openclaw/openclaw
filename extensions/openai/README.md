# OpenAI

Connect OpenAI models to OpenClaw. The plugin also provides embeddings, media
understanding, image and video generation, speech output, realtime transcription,
and realtime voice.

## Get started

For OpenAI Platform access, run:

```bash
openclaw onboard --auth-choice openai-api-key
```

You can also supply `OPENAI_API_KEY` in the Gateway's environment. Browse models
with `openclaw models list --provider openai`.

Account sign-in is available through onboarding too. Authentication methods have
different model and capability coverage; configuring chat does not configure
every media or voice feature.

See the [OpenAI setup guide](https://docs.openclaw.ai/providers/openai/setup) and
[authentication comparison](https://docs.openclaw.ai/providers/openai/authentication)
to choose the appropriate access method.
