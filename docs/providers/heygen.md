---
title: "HeyGen"
summary: "HeyGen avatar video generation setup in OpenClaw"
read_when:
  - You want to use HeyGen avatar videos in OpenClaw
  - You need the HeyGen API key/env setup
  - You want to make HeyGen the default video provider for identity-first videos
---

# HeyGen

OpenClaw ships a bundled `heygen` provider for identity-first avatar video generation.

Unlike cinematic text-to-video providers, HeyGen specializes in **avatar presenters** delivering scripted content. Use it when the video must be a specific person (real or generated) speaking on camera, not when you need cinematic b-roll or scene footage.

| Property    | Value                                                                   |
| ----------- | ----------------------------------------------------------------------- |
| Provider id | `heygen`                                                                |
| Auth        | `HEYGEN_API_KEY`                                                        |
| API         | HeyGen v3 Video Agent (`POST /v3/video-agents` + `GET /v3/videos/{id}`) |
| Docs        | <https://docs.heygen.com>                                               |

## Getting started

<Steps>
  <Step title="Set the API key">
    ```bash
    openclaw onboard --auth-choice heygen-api-key
    ```
    Or via env var:
    ```bash
    export HEYGEN_API_KEY=your_key_here
    ```
  </Step>
  <Step title="Set HeyGen as the default video provider">
    ```bash
    openclaw config set agents.defaults.videoGenerationModel.primary "heygen/video_agent_v3"
    ```
  </Step>
  <Step title="Generate a video">
    Ask the agent to generate an avatar video. HeyGen will be used automatically.
  </Step>
</Steps>

## Supported modes

| Mode           | Model            | Reference input                          |
| -------------- | ---------------- | ---------------------------------------- |
| Text-to-video  | `video_agent_v3` | None (script via prompt)                 |
| Image-to-video | `video_agent_v3` | 1+ local or remote image (scene context) |

<Note>
Text-to-video uses HeyGen's Video Agent pipeline: the prompt becomes the spoken
script, an avatar delivers it, and the final video is returned. Pass
`avatar_id` and `voice_id` via `providerOptions` to control the presenter.
</Note>

<Warning>
HeyGen Video Agent does not support video-to-video.
</Warning>

## Aspect ratios

HeyGen Video Agent accepts `16:9` (landscape) and `9:16` (portrait). `1:1` is
not supported. The `orientation` enum is `landscape | portrait` only. The
provider maps OpenClaw's `aspectRatio` to HeyGen's `orientation` field
automatically.

## Provider options

HeyGen-specific options passed via `providerOptions`:

| Option           | Type    | Description                                                    |
| ---------------- | ------- | -------------------------------------------------------------- |
| `avatar_id`      | string  | HeyGen avatar group id or look id (from `GET /v3/avatars`)     |
| `voice_id`       | string  | HeyGen voice id (from `GET /v3/voices` or `heygen voice list`) |
| `style_id`       | string  | Optional scene/style template                                  |
| `orientation`    | enum    | `landscape` or `portrait`                                      |
| `callback_url`   | string  | Webhook URL for async completion                               |
| `callback_id`    | string  | Correlation id for your webhook                                |
| `incognito_mode` | boolean | Opt out of server-side logging                                 |

Example:

```json
{
  "prompt": "Today's RBC Heritage update. Fitzpatrick holds a three shot lead...",
  "aspectRatio": "16:9",
  "providerOptions": {
    "avatar_id": "1e8adb28118944a3a7a8042656f275ed",
    "voice_id": "JB4iKi8Nm2bJl2rrG8ht",
    "orientation": "landscape"
  }
}
```

## Configuration

```json5
{
  agents: {
    defaults: {
      videoGenerationModel: {
        primary: "heygen/video_agent_v3",
      },
    },
  },
  plugins: {
    entries: {
      heygen: {
        config: {
          // Optional: skip per-request avatar_id / voice_id / style_id
          // when you always use the same presenter.
          defaultAvatarId: "1e8adb28118944a3a7a8042656f275ed",
          defaultVoiceId: "JB4iKi8Nm2bJl2rrG8ht",
          defaultStyleId: "style_corporate_brief",
        },
      },
    },
  },
}
```

Per-request `providerOptions.avatar_id` / `voice_id` / `style_id` override the
config defaults when set. If neither is set, the field is omitted and HeyGen
falls back to the workspace default presenter (or errors).

## Advanced notes

<AccordionGroup>
  <Accordion title="Avatar and voice discovery">
    Use `GET /v3/avatars` to list available avatar groups and looks, and
    `GET /v3/voices` for voices. The HeyGen CLI is a convenient alternative:
    ```bash
    heygen avatar list
    heygen voice list
    heygen voice create --prompt "warm confident male narrator" --gender male
    ```
    The `heygen voice create --prompt` command returns up to 3 designed voices
    matching a natural language description.
  </Accordion>

  <Accordion title="Authentication header">
    HeyGen uses `X-Api-Key`, not `Authorization: Bearer`. The plugin sets this
    automatically from `HEYGEN_API_KEY`.
  </Accordion>

  <Accordion title="Polling and async">
    `POST /v3/video-agents` creates a session. Most generate-mode responses
    include `video_id` immediately; async or non-generate sessions return it
    later. The plugin polls `GET /v3/video-agents/{session_id}` until
    `video_id` is populated, then polls `GET /v3/videos/{video_id}` until status
    is `completed`. Polling uses a three-tier backoff: 5s for the first 6 polls
    (30s total), 15s for the next 12 polls (3 minutes), then 30s thereafter —
    so long renders don't burn rate-limit budget on tight intervals. Maximum
    end-to-end wait is bounded by `MAX_POLL_ATTEMPTS` and the request
    `timeoutMs`.
  </Accordion>

  <Accordion title="Failure surfacing">
    When the video status is `failed`, the plugin surfaces the server's
    `failure_message` instead of a generic error so callers can see why
    HeyGen rejected the job (avatar unavailable, moderation flag, etc.).
  </Accordion>

  <Accordion title="Callback webhooks">
    Pass `callback_url` to receive completion or failure notifications
    asynchronously. Attach a `callback_id` as a correlation handle. HeyGen
    echoes it back in the webhook payload so you can match the notification to
    the original request without parsing the video id.
  </Accordion>

  <Accordion title="When to use HeyGen vs Runway or Google">
    Choose HeyGen when the video must be a specific presenter (real person,
    generated avatar, or talking-head explainer). Choose Runway, Google, or
    similar for cinematic b-roll, scene generation, or non-presenter content.
  </Accordion>
</AccordionGroup>

## Related

<CardGroup cols={2}>
  <Card title="Video generation" href="/tools/video-generation" icon="video">
    Shared tool parameters, provider selection, and async behavior.
  </Card>
  <Card title="Configuration reference" href="/gateway/configuration-reference#agent-defaults" icon="gear">
    Agent default settings including video generation model.
  </Card>
</CardGroup>
