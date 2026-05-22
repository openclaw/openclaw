---
summary: "Meeting Notes plugin: capture transcripts from Discord voice and imported meeting sources, then write summaries"
read_when:
  - You want OpenClaw to take meeting notes
  - You are wiring Discord voice, Google Meet, Slack huddles, or another meeting source into notes
  - You need the meeting_notes tool contract
title: "Meeting Notes plugin"
---

The Meeting Notes plugin is the generic notes layer for live calls and imported
meeting transcripts. It owns transcript storage, summary rendering, and the
`meeting_notes` tool. Channel plugins own capture.

## Source model

Meeting sources register `meetingNotesSourceProviders` through the plugin SDK.
The first live provider is `discord-voice`; the built-in `manual-transcript`
provider imports post-meeting transcripts.

- `live-audio`: source joins or listens to a call and streams final utterances.
- `live-caption`: source reads captions from a browser or meeting surface.
- `posthoc-transcript`: source imports a transcript or notes artifact after the meeting.
- `recording-stt`: source transcribes a recording before importing utterances.

This keeps Discord, Google Meet, Slack huddles, and future meeting surfaces out
of the notes engine. Each source supplies speaker-labeled utterances; Meeting
Notes writes the artifacts and summary.

## Enable

```json5
{
  plugins: {
    entries: {
      "meeting-notes": {
        enabled: true,
        config: {
          enabled: true,
        },
      },
      discord: {
        enabled: true,
      },
    },
  },
}
```

Discord voice capture still needs normal Discord voice setup and permissions.
See [Discord voice](/channels/discord#voice-mode).

## Tool

Use `meeting_notes` with an `action`:

- `status`: list registered providers and active sessions.
- `start`: start a live notes session.
- `stop`: stop a live session and write `summary.md`.
- `import`: import a transcript and write `summary.md`.
- `summarize`: regenerate a summary for an existing session.

Discord live notes require `providerId: "discord-voice"`, plus `guildId` and
`channelId`. `accountId` is optional when only one Discord account is active.

```json
{
  "action": "start",
  "providerId": "discord-voice",
  "guildId": "123",
  "channelId": "456",
  "title": "Weekly planning"
}
```

Stop by session id:

```json
{
  "action": "stop",
  "sessionId": "meeting-2026-05-22T10-00-00-000Z-a1b2c3d4"
}
```

Import a transcript:

```json
{
  "action": "import",
  "providerId": "manual-transcript",
  "title": "Design review",
  "transcript": "Alex: We decided to ship the Discord source first.\nSam: Action item: add Slack huddle import later."
}
```

Artifacts are stored under the OpenClaw state directory:

- `meeting-notes/<session>/metadata.json`
- `meeting-notes/<session>/transcript.jsonl`
- `meeting-notes/<session>/summary.json`
- `meeting-notes/<session>/summary.md`

## Slack Huddles

Slack huddles should use a post-meeting source first. Slack does not expose a
general bot-join live huddle audio API, but Slack huddle notes and transcript
artifacts can be imported later by a Slack-owned provider.
