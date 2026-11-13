# OpenAI

Connect OpenAI models to OpenClaw. The plugin also provides embeddings, media
understanding, image generation, speech output, realtime transcription,
realtime voice, and typed Decision evaluations.

For the Decision role, select `openai/gpt-6-luna` after configuring a Platform
API key with Decisions API access. See [Decision models](https://docs.openclaw.ai/providers/openai#decision-models)
for configuration and the text/JSON input contract.

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

Explicitly selected pre-GPT-5 models use OpenClaw's function-tool runtime rather
than Codex's native custom tools. GPT-5-family models keep the Codex runtime.

See the [OpenAI setup guide](https://docs.openclaw.ai/providers/openai/setup) and
[authentication comparison](https://docs.openclaw.ai/providers/openai/authentication)
to choose the appropriate access method.

## Talk acknowledgment

For GPT-Live Talk sessions with Gateway-owned agent delegation, set
`talk.realtime.providers.openai.acknowledgement` to a fixed launch phrase:

```bash
openclaw config set talk.realtime.providers.openai.acknowledgement "One moment."
```

An unset or blank value keeps the default natural acknowledgment. Start a new
Talk session to use a changed phrase. See [Talk realtime sessions](https://docs.openclaw.ai/nodes/talk/realtime-sessions)
for transport coverage, configuration reload behavior, and limitations.
