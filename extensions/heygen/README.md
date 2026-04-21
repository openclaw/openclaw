# HeyGen Video Provider for OpenClaw

Adds [HeyGen](https://www.heygen.com) as a first-class provider for OpenClaw's built-in `video_generate` tool. Every agent that already uses `video_generate` (Google Veo, Runway, Kling, Wan, MiniMax, etc.) can now generate identity-preserving avatar videos through the same interface.

## What this plugin does

Unlike cinematic video providers (Veo, Runway, Kling) that excel at open-ended scene generation, HeyGen is built for **identity-first avatar videos**: a specific avatar, a specific voice, scripted narration, and full control over orientation and style. This plugin wires the HeyGen v3 Video Agent surface into OpenClaw so agents can:

- Drop an `avatar_id` / `voice_id` / `style_id` and get a consistent on-brand presenter.
- Pass scene context via file attachments (images) to ground the narration.
- Generate landscape or portrait videos for any channel.
- Receive async completion via webhook (`callback_url` + `callback_id`) or poll to completion.

## When to use HeyGen vs other video providers

Pick HeyGen when the video needs a **recognizable human presenter**: explainer videos, internal training, sales enablement, localized announcements, talking-head content. Pick Veo / Runway / Kling when the video needs **imagined scenes without a fixed identity**: cinematic b-roll, scene generation, non-presenter content.

## Enable

```bash
openclaw plugins enable heygen
```

Restart the Gateway after enabling.

```bash
openclaw gateway restart
```

## Authenticate

Set your HeyGen API key via either:

- Environment variable: `HEYGEN_API_KEY=hg_...`
- CLI: `openclaw onboard --auth-choice heygen-api-key`

Get a key from the [HeyGen API settings page](https://app.heygen.com/settings/api).

## Make it the default video provider

```bash
openclaw config set agents.defaults.videoGenerationModel.primary "heygen/video_agent_v3"
```

## Set a default avatar / voice (optional)

Skip the per-request `avatar_id` / `voice_id` when you always use the same presenter:

```bash
openclaw config set plugins.entries.heygen.config.defaultAvatarId "1e8adb28118944a3a7a8042656f275ed"
openclaw config set plugins.entries.heygen.config.defaultVoiceId  "JB4iKi8Nm2bJl2rrG8ht"
openclaw config set plugins.entries.heygen.config.defaultStyleId  "style_corporate_brief"
```

Per-request `providerOptions.avatar_id` / `voice_id` / `style_id` override the config defaults when set. If neither is set, the field is omitted and HeyGen falls back to the workspace default presenter (or errors).

Need an avatar id? Run the [`heygen-avatar`](https://github.com/openclaw/skills) skill to upload a photo, create a HeyGen avatar via the Avatar V pipeline, and capture the `avatar_id` + `voice_id` pair. Paste into the config block above.

## Usage

```ts
await video_generate({
  model: "heygen/video_agent_v3",
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

## Capabilities

- Modes: `generate`, `imageToVideo` (reference image attached as scene context)
- Aspect ratios: `16:9` (landscape), `9:16` (portrait). `1:1` is not supported. HeyGen Video Agent orientation enum is `landscape | portrait` only.
- Max duration: 300 seconds (5 minutes). This is a plugin-side cap, not an API cap. HeyGen will accept longer prompts; bump `MAX_DURATION_SECONDS` in `video-generation-provider.ts` if you need longer renders.
- Reference files: up to 20 input images forwarded as HeyGen file attachments

## Avatar and voice discovery

Use `GET /v3/avatars` to list available avatar groups and looks, and `GET /v3/voices` for voices. The HeyGen CLI is a convenient alternative:

```bash
heygen avatar list
heygen voice list
heygen voice create --prompt "warm confident male narrator" --gender male
```

The `heygen voice create --prompt` command returns up to 3 designed voices matching a natural language description.

## Provider options

HeyGen-specific options passed via `providerOptions`:

| Key              | Type    | Description                                                       |
| ---------------- | ------- | ----------------------------------------------------------------- |
| `avatar_id`      | string  | HeyGen avatar look id (from `GET /v3/avatars`).                   |
| `voice_id`       | string  | HeyGen voice id (from `GET /v3/voices`).                          |
| `style_id`       | string  | Optional curated visual style template id.                        |
| `orientation`    | enum    | `landscape` or `portrait`. Derived from `aspectRatio` if omitted. |
| `callback_url`   | string  | Webhook URL for async completion notifications.                   |
| `callback_id`    | string  | Caller-defined correlation id echoed back in the webhook payload. |
| `incognito_mode` | boolean | Opt out of server-side logging.                                   |

## API reference

- Create session: `POST https://api.heygen.com/v3/video-agents`
- Session poll (when `video_id` is null on create): `GET https://api.heygen.com/v3/video-agents/{session_id}`
- Video poll: `GET https://api.heygen.com/v3/videos/{video_id}`
- Auth header: `X-Api-Key`

See the [HeyGen Video Agent API docs](https://developers.heygen.com/reference/list-video-agent-sessions.md) for full parameter coverage.

## Links

- HeyGen API docs: https://docs.heygen.com
- v3 Video Agent reference: https://developers.heygen.com/reference/list-video-agent-sessions.md
- OpenClaw plugin SDK: https://docs.openclaw.com/plugins

## License

MIT
