---
summary: "Make the bot join, move between, and leave Discord voice channels with selected users"
read_when:
  - Configuring voice.followUsers so the bot follows people between voice channels
  - Debugging follow-mode joins, barge-in, or echo handling
title: "Follow users in Discord voice"
sidebarTitle: "Follow users in voice"
---

Follow mode makes the bot track selected users as they move between Discord voice channels.

## Follow users in voice

Use `voice.followUsers` when you want the Discord voice bot to stay with one or more known Discord users instead of joining a fixed channel at startup or waiting for `/vc join`.

```json5
{
  channels: {
    discord: {
      voice: {
        enabled: true,
        followUsersEnabled: true,
        followUsers: ["discord:123456789012345678"],
        allowedChannels: [
          {
            guildId: "123456789012345678",
            channelId: "234567890123456789",
          },
        ],
      },
    },
  },
}
```

Behavior:

- `followUsers` accepts raw Discord user IDs and `discord:<id>` values. OpenClaw normalizes both forms before matching voice-state events.
- `followUsersEnabled` defaults to `true` when `followUsers` is configured. Set it to `false` to keep the saved list but stop automatic voice following.
- `followUsers` controls voice residency only. It does not grant speaker access or owner authority; configure `commands.ownerAllowFrom` and guild or channel users and roles separately.
- When a followed user joins an allowed voice channel, OpenClaw joins that channel. When the user moves, OpenClaw moves with them. When the active followed user disconnects, OpenClaw leaves.
- If multiple followed users are in the same guild and the active followed user leaves, OpenClaw moves to another tracked followed user's channel before leaving the guild. If several followed users move at once, the latest observed voice-state event wins.
- `allowedChannels` still applies. A followed user in a disallowed channel is ignored, and a follow-owned session moves to another followed user or leaves.
- OpenClaw reconciles missed voice-state events on startup and at a bounded interval. Reconciliation samples configured guilds and caps REST lookups per run, so very large `followUsers` lists may take more than one interval to converge.
- If Discord or an admin moves the bot while it is following a user, OpenClaw rebuilds the voice session and preserves follow ownership when the destination is allowed. If the bot is moved outside `allowedChannels`, OpenClaw leaves and rejoins the configured target when one exists.
- DAVE receive recovery may leave and rejoin the same channel after repeated decrypt failures. Follow-owned sessions keep their follow ownership through that recovery path, so a later followed-user disconnect still leaves the channel.

Choose between the join modes:

- Use `followUsers` for personal or operator setups where the bot should automatically be in voice when you are.
- Use `autoJoin` for fixed rooms. Add `whenOccupied: true` when the bot should be present only while humans are in that room; omit it for always-on voice presence.
- Use `/vc join` for one-off joins or rooms where automatic voice presence would be surprising.

Discord voice codec:

- Voice receive logs show `discord voice: opus decoder: libopus-wasm`.
- Realtime playback encodes raw 48 kHz stereo PCM to Opus with the same bundled `libopus-wasm` package before handing packets to `@discordjs/voice`.
- File and provider-stream playback transcodes to raw 48 kHz stereo PCM with ffmpeg, then uses `libopus-wasm` for the Opus packet stream sent to Discord.

STT plus TTS pipeline:

- Discord PCM capture is converted to a WAV temp file.
- `tools.media.audio` handles STT, for example `openai/gpt-4o-mini-transcribe`.
- Batch capture respects the largest applicable [audio input limit](/nodes/audio), including configured model and CLI fallbacks. Oversized captures stop with a warning to speak a shorter segment; partial audio is not transcribed. This limit does not buffer or truncate direct realtime streams.
- The transcript is sent through Discord ingress and routing while the response LLM runs with a voice-output policy that hides the agent `tts` tool and asks for returned text, because Discord voice owns final TTS playback.
- `voice.model`, when set, overrides only the response LLM for this voice-channel turn.
- `voice.tts` is merged over `tts`; streaming-capable providers feed the player directly, otherwise the resulting audio file is played in the joined channel.

Default agent-proxy voice-channel session example:

```json5
{
  channels: {
    discord: {
      voice: {
        enabled: true,
        model: "openai/gpt-5.6-sol",
        followUsersEnabled: true,
        followUsers: ["123456789012345678"],
        realtime: {
          provider: "openai",
          model: "gpt-realtime-2.1",
          speakerVoice: "cedar",
        },
      },
    },
  },
}
```

With no `voice.agentSession` block, each voice channel gets its own routed OpenClaw session. For example, `/vc join channel:234567890123456789` talks to the session for that Discord voice channel. The realtime model is only the voice front end; substantive requests are handed to the configured OpenClaw agent. If the realtime model produces a final transcript without calling the consult tool, OpenClaw forces the consult as a fallback so the default still behaves like talking to the agent.

Legacy STT plus TTS example:

```json5
{
  channels: {
    discord: {
      voice: {
        enabled: true,
        mode: "stt-tts",
        model: "openai/gpt-5.4-mini",
        tts: {
          provider: "openai",
          providers: {
            openai: {
              model: "gpt-4o-mini-tts",
              speakerVoice: "cedar",
            },
          },
        },
      },
    },
  },
}
```

Realtime bidi example:

```json5
{
  channels: {
    discord: {
      voice: {
        enabled: true,
        mode: "bidi",
        model: "openai/gpt-5.6-sol",
        realtime: {
          provider: "openai",
          model: "gpt-realtime-2.1",
          speakerVoice: "cedar",
          toolPolicy: "safe-read-only",
          consultPolicy: "always",
        },
      },
    },
  },
}
```

Voice as an extension of an existing Discord channel session:

```json5
{
  channels: {
    discord: {
      voice: {
        enabled: true,
        mode: "agent-proxy",
        model: "openai/gpt-5.6-sol",
        agentSession: {
          mode: "target",
          target: "channel:123456789012345678",
        },
        realtime: {
          provider: "openai",
          model: "gpt-realtime-2.1",
          speakerVoice: "cedar",
        },
      },
    },
  },
}
```

In `agent-proxy` mode the bot joins the configured voice channel, but OpenClaw agent turns use the target channel's normal routed session and agent. The realtime voice session speaks the returned result back into the voice channel. The supervisor agent can still use normal message tools according to its tool policy, including sending a separate Discord message if that is the right action.

While a delegated OpenClaw run is active, command-authorized Discord conversation transcripts are treated as live run control before starting another agent turn. Phrases such as "status", "cancel that", "use the smaller fix", or "when you're done also check tests" are classified as status, cancel, steering, or follow-up input for the active session. Status, cancel, accepted steering, and follow-up outcomes are spoken back into the voice channel so the caller knows whether OpenClaw handled the request.

When OpenClaw cancels a delegated consult, Discord records cancellation rather than a failure and does not play the generic error fallback. Matching late provider tool calls receive the same terminal cancellation instead of restarting the work. The voice session remains available for the next request; timeouts and genuine failures keep their normal error handling.

Useful target forms:

- `target: "channel:123456789012345678"` routes through a Discord text channel session.
- `target: "123456789012345678"` is treated as a channel target.
- `target: "dm:123456789012345678"` or `target: "user:123456789012345678"` routes through that direct-message session.

Echo-heavy OpenAI Realtime example:

```json5
{
  channels: {
    discord: {
      voice: {
        enabled: true,
        mode: "bidi",
        model: "openai/gpt-5.6-sol",
        realtime: {
          provider: "openai",
          model: "gpt-realtime-2.1",
          speakerVoice: "cedar",
          bargeIn: true,
          minBargeInAudioEndMs: 500,
          consultPolicy: "always",
          providers: {
            openai: {
              interruptResponseOnInputAudio: false,
            },
          },
        },
      },
    },
  },
}
```

Use this when the model hears its own Discord playback through an open mic, but you still want to interrupt it by speaking. OpenClaw keeps OpenAI from auto-interrupting on raw input audio, while `bargeIn: true` lets Discord speaker-start events and already-active speaker audio cancel active realtime responses before the next captured turn reaches OpenAI. Very early barge-in signals with `audioEndMs` below `minBargeInAudioEndMs` are treated as likely echo/noise and ignored so the model does not cut off at the first playback frame.

Expected voice logs:

- On join: `discord voice: joining ... voiceSession=... supervisorSession=... agentSessionMode=... voiceModel=... realtimeModel=...`
- On realtime start: `discord voice: realtime bridge starting ... autoRespond=false interruptResponse=false bargeIn=false minBargeInAudioEndMs=...`
- On speaker audio: `discord voice: realtime speaker turn opened ...`, `discord voice: realtime input audio started ... outputAudioMs=... outputActive=...`, and `discord voice: realtime speaker turn closed ... chunks=... discordBytes=... realtimeBytes=... interruptedPlayback=...`
- On skipped stale speech: `discord voice: realtime forced agent consult skipped reason=incomplete-transcript ...` or `reason=non-actionable-closing ...`
- On realtime response completion: `discord voice: realtime audio playback finishing reason=completed ... audioMs=... chunks=...`; buffered audio can still be playing after this line.
- On ordinary playback backpressure: `discord voice: realtime audio playback buffering ... bufferedBytes=...`; playback continues when Discord drains the buffered audio.
- Discord acknowledges scoped provider playback marks after their PCM is consumed. xAI waits for these acknowledgments before starting a following response; clearing discarded audio does not report it as played.
- On playback stop/reset: `discord voice: realtime audio playback stopped reason=... audioMs=... elapsedMs=... chunks=...`
- On realtime consult: `discord voice: realtime consult requested ... voiceSession=... supervisorSession=... question=...`
- On agent answer: `discord voice: agent turn answer ...`
- On queued exact speech: `discord voice: realtime exact speech queued ... queued=... outputAudioMs=... outputActive=...`, followed by `discord voice: realtime exact speech dequeued reason=player-idle ...`
- On barge-in detection: `discord voice: realtime barge-in detected source=speaker-start ...` or `discord voice: realtime barge-in detected source=active-speaker-audio ...`, followed by `discord voice: realtime barge-in requested reason=... outputAudioMs=... outputActive=...`
- On realtime interruption: `discord voice: realtime model interrupt requested client:response.cancel reason=barge-in`, followed by either `discord voice: realtime model audio truncated client:conversation.item.truncate reason=barge-in audioEndMs=...` or `discord voice: realtime model interrupt confirmed server:response.done status=cancelled ...`
- On ignored echo/noise: `discord voice: realtime model interrupt ignored client:conversation.item.truncate.skipped reason=barge-in audioEndMs=0 minAudioEndMs=250`
- On disabled barge-in: `discord voice: capture ignored: ... reason=protected playback`
- On idle playback: `discord voice: realtime barge-in ignored reason=... outputActive=false ... playbackChunks=0`

To debug cut-off audio, read the realtime voice logs as a timeline:

1. `realtime audio playback started` means Discord has begun playing assistant audio. The bridge starts counting assistant output chunks, Discord PCM bytes, provider realtime bytes, and synthesized audio duration from this point.
2. `realtime speaker turn opened` marks a Discord speaker becoming active. If playback is already active and `bargeIn` is enabled, this can be followed by `barge-in detected source=speaker-start`.
3. `realtime input audio started` marks the first actual audio frame received for that speaker turn. `outputActive=true` or a nonzero `outputAudioMs` here means the mic is sending input while assistant playback is still active.
4. `barge-in detected source=active-speaker-audio` means OpenClaw saw live speaker audio while assistant playback was active. This is useful for distinguishing a real interruption from a Discord speaker-start event with no useful audio.
5. `barge-in requested reason=...` means OpenClaw asked the realtime provider to cancel or truncate the active response. `outputAudioMs` and `playbackChunks` describe generated audio; the subsequent `audioEndMs` truncation field records consumed audio for each native item. Discord measures local consumption from Opus packets prepared by AudioPlayer, at 20 ms granularity; it cannot measure remote listener playout.
6. `realtime audio playback stopped reason=...` is the local Discord playback reset point. `player-idle` means Discord finished consuming the audio; provider `response.done` and encoder completion alone do not mean playback is finished. Other reasons include `barge-in`, `provider-clear-audio`, `forced-agent-consult`, `stream-close`, `output-audio-overflow`, and `session-close`.
7. `realtime speaker turn closed` summarizes the captured input turn. `chunks=0` or `hasAudio=false` means the speaker turn opened but no usable audio reached the realtime bridge. `interruptedPlayback=true` means that input turn overlapped assistant output and triggered barge-in logic.

Useful fields:

- `outputAudioMs`: assistant audio duration generated by the realtime provider before the log line.
- `audioMs`: assistant audio duration that OpenClaw counted before playback stopped.
- `elapsedMs`: wall-clock time between opening and closing the playback stream or speaker turn.
- `discordBytes`: 48 kHz stereo PCM bytes sent to or received from Discord voice.
- `realtimeBytes`: provider-format PCM bytes sent to or received from the realtime provider.
- `playbackChunks`: assistant audio chunks forwarded to Discord for the active response.
- `sinceLastAudioMs`: gap between the last captured speaker audio frame and the speaker turn closing.

Common patterns:

- Immediate cut-off with `source=active-speaker-audio`, small `outputAudioMs`, and the same user nearby usually points to speaker echo entering the mic. Raise `voice.realtime.minBargeInAudioEndMs`, lower speaker volume, use headphones, or set `voice.realtime.providers.openai.interruptResponseOnInputAudio: false`.
- `source=speaker-start` followed by `speaker turn closed ... hasAudio=false` means Discord reported a speaker start but no audio reached OpenClaw. That can be a transient Discord voice event, noise gate behavior, or a client briefly keying the mic.
- `audio playback stopped reason=output-audio-overflow` means sustained delivery problems exceeded the bounded pending-audio queue. Check the associated `Discord realtime audio playback overflow` error and preceding provider or Discord connection diagnostics; ordinary playback backpressure should not produce this error.
- `Discord voice receive backlog exceeded` means identity lookup, decoding, or local disk could not keep up with incoming audio. OpenClaw bounds each receive stream at 1,000 pending packets and 1 MiB of encoded audio; speak again after the bottleneck clears. Other speakers and any registered capture remain active, and incomplete speech cannot become a new conversation command.
- `conversation audio backlog exceeded`, `conversation is busy`, or `conversation transcript limit exceeded` means a conversation limit was reached. Recording continues; wait for pending requests to finish or repeat a shorter, complete request.
- `Discord voice recording backlog exceeded` means pending WAV files reached the recording queue's chunk or byte limit. The affected utterance stops, and the registered capture remains available after pending audio processing catches up.
- `audio playback stopped reason=stream-close` without a nearby barge-in or `provider-clear-audio` means the local Discord playback stream ended unexpectedly. Check the preceding provider and Discord player logs.
- `capture ignored: ... reason=protected playback` means OpenClaw intentionally withheld conversational input while assistant audio was active. An explicitly started capture still records that speech. Enable `voice.realtime.bargeIn` if you want speech to interrupt playback.
- `barge-in ignored ... outputActive=false` means Discord or provider VAD reported speech, but OpenClaw had no active playback to interrupt. This should not cut off audio.

Credentials are resolved per component: LLM route auth for `voice.model`, STT auth for `tools.media.audio`, TTS auth for `tts`/`voice.tts`, and realtime provider auth for `voice.realtime.providers` or the provider's normal auth config.
