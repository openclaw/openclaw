# HeyGen Video Provider for OpenClaw

Adds [HeyGen](https://www.heygen.com) as a first-class provider for OpenClaw's built-in `video_generate` tool. Every agent that already uses `video_generate` (Google Veo, Runway, Kling, Wan, MiniMax, etc.) can now generate identity-preserving avatar videos through the same interface.

## What this plugin does

Unlike cinematic video providers (Veo, Runway, Kling) that excel at open-ended scene generation, HeyGen is built for **identity-first avatar videos**: a specific avatar, a specific voice, scripted narration, and full control over orientation and style. This plugin wires the full v3 Video Agent surface into OpenClaw so agents can:

- Drop an `avatar_id` / `voice_id` / `style_id` and get a consistent on-brand presenter.
- Pass scene context via file attachments (images, PDFs) to ground the narration.
- Generate landscape, portrait, or square videos for any channel.
- Receive async completion via webhook (`callback_url` + `callback_id`) or poll to completion.

## Installation

Once merged into the `openclaw/openclaw` monorepo under `extensions/heygen`, the plugin is **enabled by default**. No additional install steps are required.

For third-party distribution via ClawHub:

```bash
openclaw plugins install clawhub:@openclaw/heygen-provider
```

## Authentication

Set your HeyGen API key via either:

- Environment variable: `HEYGEN_API_KEY=hg_...`
- CLI flag: `--heygen-api-key <key>` during `openclaw init` or per-run

Get a key from the [HeyGen API settings page](https://app.heygen.com/settings/api).

## Usage

```ts
// Through OpenClaw's video_generate tool
await video_generate({
  model: "heygen/avatar_iv",
  prompt: "Welcome new agents to HeyGen. Explain the v3 Video Agent API in under 45 seconds.",
  aspectRatio: "16:9",
  providerOptions: {
    avatar_id: "avatar_demo_123",
    voice_id: "voice_demo_456",
    style_id: "style_corporate_brief",
    callback_url: "https://my.app/webhooks/heygen",
    callback_id: "onboarding-welcome-001",
  },
});
```

## Models

| Model         | Description                                                            |
| ------------- | ---------------------------------------------------------------------- |
| `avatar_iv`   | Default. HeyGen v3 Video Agent engine (prompt plus avatar plus voice). |
| `video_agent` | Alias for the v3 Video Agent engine.                                   |

## Capabilities

- Modes: `generate`, `imageToVideo` (single reference image for scene context)
- Aspect ratios: `16:9`, `9:16`, `1:1`
- Max duration: 120 seconds
- Reference files: up to one input image forwarded as HeyGen file context

## Provider options

| Key            | Type   | Description                                                       |
| -------------- | ------ | ----------------------------------------------------------------- |
| `avatar_id`    | string | HeyGen avatar look id (omit to let the agent auto-select).        |
| `voice_id`     | string | HeyGen voice id (omit to let the agent auto-select).              |
| `style_id`     | string | Optional curated visual style template id.                        |
| `orientation`  | string | `landscape`, `portrait`, or `square`. Derived from aspect ratio.  |
| `callback_url` | string | Webhook URL to receive completion or failure notifications.       |
| `callback_id`  | string | Caller-defined correlation id echoed back in the webhook payload. |

## Differentiation

HeyGen sits alongside cinematic providers in your agent's toolbox. Pick it when the video needs a **recognizable human presenter**: explainer videos, internal training, sales enablement, localized announcements. Pick Veo/Runway/Kling when the video needs **imagined scenes without a fixed identity**.

## Links

- HeyGen API docs: https://docs.heygen.com
- v3 Video Agent reference: https://docs.heygen.com/docs/video-agent
- OpenClaw plugin SDK: https://docs.openclaw.com/plugins

## License

MIT
