# OpenClaw Vydra Provider

Official OpenClaw provider plugin for Vydra image, video, and speech generation.

Install from OpenClaw:

```bash
openclaw plugins install @openclaw/vydra-provider
openclaw gateway restart
```

Set `VYDRA_API_KEY`, then configure an image, video, or speech model. See
<https://docs.openclaw.ai/providers/vydra> for capability details and examples.

`veo3` accepts text-to-video requests. `kling` motion control requires exactly
one remote HTTPS character image in `inputImages` and one distinct remote HTTPS
motion video in `inputVideos`. Image-only, buffered, extra and audio references
are rejected before submission. The image is never reused as the motion video.
See the [native Kling input contract](https://www.vydra.ai/docs/models/kling).
