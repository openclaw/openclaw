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

| Property    | Value                                                     |
| ----------- | --------------------------------------------------------- |
| Provider id | `heygen`                                                  |
| Auth        | `HEYGEN_API_KEY`                                          |
| API         | HeyGen v3 Video Agent (`POST /v3/video-agents` + polling) |
| Docs        | https://docs.heygen.com                                   |

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
    openclaw config set agents.defaults.videoGenerationModel.primary "heygen/avatar_iv"
    ```
  </Step>
  <Step title="Generate a video">
    Ask the agent to generate an avatar video. HeyGen will be used automatically.
  </Step>
</Steps>

## Supported modes

| Mode           | Model       | Reference input          |
| -------------- | ----------- | ------------------------ |
| Text-to-video  | `avatar_iv` | None (script via prompt) |
| Image-to-video | `avatar_iv` | 1 local or remote image  |

<Note>
Text-to-video uses HeyGen's Video Agent pipeline: the prompt becomes the spoken
script, an avatar delivers it, and the final video is returned. Pass
`avatar_id` and `voice_id` via `providerOptions` to control the presenter.
</Note>

## Provider options

HeyGen-specific options can be passed via `providerOptions`:

| Option         | Type   | Description                                                    |
| -------------- | ------ | -------------------------------------------------------------- |
| `avatar_id`    | string | HeyGen avatar group id or look id (from `GET /v3/avatars`)     |
| `voice_id`     | string | HeyGen voice id (from `GET /v3/voices` or `heygen voice list`) |
| `style_id`     | string | Optional scene/style template                                  |
| `orientation`  | enum   | `landscape`, `portrait`, or `square`                           |
| `callback_url` | string | Webhook URL for async completion                               |
| `callback_id`  | string | Correlation id for your webhook                                |

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
        primary: "heygen/avatar_iv",
      },
    },
  },
}
```

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

  <Accordion title="Polling and async">
    HeyGen's Video Agent is async. After submission, OpenClaw polls
    `GET /v3/videos/{id}` every 5 seconds until status is `completed`.
    Longer videos (60 to 120 seconds) may take several minutes to render.
  </Accordion>

  <Accordion title="Aspect ratio">
    HeyGen accepts `16:9` (landscape), `9:16` (portrait), and `1:1` (square).
    The provider maps OpenClaw's `aspectRatio` to HeyGen's `orientation` field
    automatically.
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
