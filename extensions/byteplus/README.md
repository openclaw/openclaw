# OpenClaw BytePlus Provider

Official OpenClaw provider plugin for BytePlus model inference and Seedance
video generation.

Install from OpenClaw:

```bash
openclaw plugins install @openclaw/byteplus-provider
openclaw gateway restart
```

Set `BYTEPLUS_API_KEY`, then select a `byteplus/*` or `byteplus-plan/*` model.

See <https://docs.openclaw.ai/concepts/model-providers#byteplus-international>
for model setup and <https://docs.openclaw.ai/tools/video-generation> for
Seedance video generation.

Video task submission and polling use headers and proxy settings from
`models.providers.byteplus.request`. Generated video downloads do not inherit
those task credentials or transport overrides.
