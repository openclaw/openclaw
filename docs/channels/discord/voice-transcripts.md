---
summary: "Continuous voice capture, transcript storage, and automatic meeting notes"
read_when:
  - Capturing transcripts from a Discord voice channel
  - Configuring a listen-only bot that writes meeting notes
title: "Discord voice transcripts and meeting notes"
sidebarTitle: "Voice transcripts"
---

Record what is said in a Discord voice channel and turn it into transcripts and meeting notes.

## Capture voice transcripts

`voice.autoJoin` controls presence and conversation; it does not start durable
recording. Start capture explicitly with the `transcripts` agent tool, or configure
an existing `transcripts.autoStart` source. See [Transcripts CLI](/cli/transcripts#configuration)
for configuration and inspection commands.

An authorized agent can start capture with:

```json
{
  "action": "start",
  "providerId": "discord-voice",
  "accountId": "work",
  "guildId": "123456789012345678",
  "channelId": "234567890123456789"
}
```

Capture subscribes to that exact account, guild, and channel until stopped. It
attaches to an existing matching voice connection without changing conversation
or occupancy ownership. When it matches the account's configured `voice.autoJoin`
target, normal voice conversation remains enabled regardless of which starts
first. With `voice.autoJoin[].whenOccupied: true`, continuous capture waits through empty rooms and resumes
on the next normal join. It also follows same-channel connection recovery and
replacement of the same account's voice manager. Capture never moves an existing
connection to another channel.

An authorized capture records participants in the selected room independently of
command access. Guild/channel users and roles, `commands.ownerAllowFrom`, and
wake-name gates still control conversation, agent tools, and active-run controls;
recording does not grant any of those permissions. Speech during protected
playback is recorded without interrupting playback or triggering a reply.
If OpenClaw first subscribes to someone already speaking, it records the available
speech without conversational input or commands. Normal conversation requires a
fresh receive stream after the current stream ends; brief pauses within
`voice.captureSilenceGraceMs` keep the current stream and its recording-only behavior.

Full recording coverage requires batch audio understanding. Recording uses one
per-speaker audio stream and batch transcription, with the
receiver's user ID, independently resolved display label, and audio-ingress time.
Authorized speakers can also feed realtime conversation from the same decoded
audio. Recording continues when all realtime speaker connections are busy.
This costs an additional batch transcription for realtime speech, but keeps durable
recording independent of realtime provider delivery and conversation authorization. Continuous speech is split into contiguous, bounded audio uploads;
these are segments within the same capture session, not separate meetings.
In `stt-tts` mode, authorized conversation shares that batch transcription and
waits for the normal end of speech before responding.

Existing realtime-only setups can record final text from their active per-speaker
connections when batch transcription is disabled or no batch backend is available.
This limited route requires every submitted audio packet to belong to the same
active capture; it waits for all batch work to settle and never duplicates a
successful or silent batch result. Mixed capture input, failed or oversized audio,
and provider continuity resets cannot produce recording fallback text. It covers
only speakers admitted to realtime conversation, so it does not provide independent
room recording. `/vc status` shows a coverage warning and directs operators to
configure audio transcription. Starting capture with `tools.media.audio.enabled`
set to `false` requires an existing active realtime conversation; otherwise it returns an
enablement error. Pending realtime finals are limited to 1 MiB and 1,000 entries
per speaker connection.

Conversation authorization and replies run separately from recording. Each voice
connection permits eight unfinished voice requests, with at most 1 MiB of decoded
audio waiting for admission per request. Batch requests retain at most 1 MiB of
transcript text and 1,000 segments. Reaching a limit discards that entire voice
request and continues recording; speak again after pending requests finish, or
use a shorter utterance.
Pending Discord recording work is capped across the Gateway process at 128 chunks
and 64 MiB of WAV data. If transcription or saving notes cannot keep up, the
affected receive stream stops and the capture stays registered. This budget
survives voice reconnections; wait for pending audio processing to finish, then
speak again.
If transcription fails or omits input (such as an oversized upload), a chunk loses command access, or starting or stopping
capture discards an uncaptured fragment below the minimum duration, successful notes remain
saved, but the incomplete utterance does not trigger an agent reply or active-run
control. Restored access applies to subsequent utterances, not missing chunks.
A completed transcription with no text is allowed and does not invalidate the utterance.

With no configured auto-join target or active conversation in that guild, a
manual capture joins silently in transcript-only mode. A subsequent `/vc join`
enables normal conversation on that connection. A capture for another channel
stays registered without taking over the configured or active conversation,
including when a recorder reconnect waits behind a newer conversation join.

Stop with the `transcripts` tool's `stop` action and the returned `sessionId`.
Stopping capture works while disconnected and does not disconnect a connection
owned by conversation. Already-received audio can finish recording across a
connection transition while the same capture remains active. Stop or replacement
revokes pending publication; old audio cannot enter a new capture.
Starting a new capture for the same registered source transfers the subscription
without reconnecting or repeating target validation, even while it is dormant.
Continuous capture can span multiple room occupations until explicitly stopped. For automatic
meeting boundaries, use `transcripts.autoStart[].whenOccupied` as described below.
Summaries are not automatically posted to Discord.

## Meeting notes

Use the `discord-voice` transcripts provider to keep a note-taking bot in a voice
channel only while humans are present. Without a conversational auto-join target or active conversation, capture is listen-only and does not start a realtime provider. Attaching capture to an existing conversation preserves its ownership.
Enable Discord voice, configure an authenticated [speech-to-text provider](/nodes/audio),
and add an occupancy-driven transcript source:

```json5
{
  channels: {
    discord: {
      voice: { enabled: true },
    },
  },
  tools: {
    media: {
      models: [{ provider: "openai", model: "gpt-4o-transcribe", capabilities: ["audio"] }],
      audio: { enabled: true },
    },
  },
  transcripts: {
    autoStart: [
      {
        providerId: "discord-voice",
        guildId: "123456789012345678",
        channelId: "234567890123456789",
        whenOccupied: true,
      },
    ],
  },
}
```

The bot needs Connect permission in the target channel and the `GuildVoiceStates`
intent, which `voice.enabled: true` enables by default. Do not explicitly disable
`channels.discord.intents.voiceStates`. Keep the channel inside any configured
`voice.allowedChannels` allowlist. Use `transcripts.autoStart`, not conversational
`voice.autoJoin`, for this note-taking recipe. Tell participants that the bot
captures and stores transcripts before enabling it.

For multiple Discord accounts, add `accountId` to select the voice-enabled bot
unless the configured default account resolves it unambiguously. Configure at
most one occupancy-driven `discord-voice` entry per account and guild; the bot
cannot capture multiple voice channels in the same guild. Later conflicting
entries are skipped with a warning.

The bot joins on human arrival, including when the channel is already occupied
at startup. After the last human leaves, it waits 30 seconds before leaving and
generating notes; a return during that grace keeps capture running. Episodes use
generated session IDs, ignoring a configured `sessionId`. A session stopped less
than 10 minutes ago can reopen for the same source after a Gateway restart or a
short gap when its stored origin confirms a generated ID. It preserves its ID,
start time, and accumulated utterances. Supplied IDs and legacy records with an
unknown origin stay archived; capture starts fresh without changing those notes.

Notes include participants, an overview, decisions, action items, and risks.
They use the agent's utility model, falling back to its primary model and then
deterministic heuristic notes if model generation fails. Read stored notes with
the `transcripts` tool, the [CLI](/cli/transcripts), or the Control UI Meetings
page. The tool's `summarize` action regenerates notes from the stored transcript.
