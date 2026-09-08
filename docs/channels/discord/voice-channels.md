---
summary: "Realtime Discord voice channels, auto-join, realtime modes, and voice message attachments"
read_when:
  - Setting up a realtime voice conversation in a Discord voice channel
  - Handling inbound Discord voice message attachments
title: "Discord voice channels"
sidebarTitle: "Voice channels"
---

Realtime voice conversations in Discord voice channels, plus the separate voice message attachment format.

## Voice

Discord has two distinct voice surfaces: realtime **voice channels** (continuous conversations) and **voice message attachments** (the waveform preview format). The gateway supports both.

## Voice channels

Setup checklist:

1. Enable Message Content Intent in the Discord Developer Portal.
2. Enable Server Members Intent when role/user allowlists are used.
3. Invite the bot with `bot` and `applications.commands` scopes.
4. Grant Connect, Speak, Send Messages, and Read Message History in the target voice channel.
5. Enable native commands (`commands.native` or `channels.discord.commands.native`).
6. Configure `channels.discord.voice`.

Use `/vc join|leave|status` to control sessions. The command uses the account default agent and follows the same allowlist and group policy rules as other Discord commands.

```bash
/vc join channel:<voice-channel-id>
/vc status
/vc leave
```

To inspect the bot's effective permissions before joining:

```bash
openclaw channels capabilities --channel discord --target channel:<voice-channel-id>
```

Auto-join example:

```json5
{
  channels: {
    discord: {
      voice: {
        enabled: true,
        model: "openai/gpt-5.6-sol",
        autoJoin: [
          {
            guildId: "123456789012345678",
            channelId: "234567890123456789",
            whenOccupied: true,
          },
        ],
        allowedChannels: [
          {
            guildId: "123456789012345678",
            channelId: "234567890123456789",
          },
        ],
        daveEncryption: true,
        decryptionFailureTolerance: 24,
        connectTimeoutMs: 30000,
        reconnectGraceMs: 15000,
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

Notes:

- The OpenAI `agent-proxy` response and wake-name policies below require a GA realtime model, such as `gpt-realtime-2.1`. GPT-Live currently responds to audio autonomously and does not enforce those policies; do not rely on wake-name gating with GPT-Live in a shared voice channel.
- Discord voice is opt-in for text-only configs; set `channels.discord.voice.enabled=true` (or keep an existing `channels.discord.voice` block) to enable `/vc` commands, the voice runtime, and the `GuildVoiceStates` gateway intent. `channels.discord.intents.voiceStates` can explicitly override the intent subscription; leave it unset to follow effective voice enablement.
- `voice.mode` controls the conversation path. The default is `agent-proxy`: a realtime voice front end handles turn timing, interruption, and playback, delegates substantive work to the routed OpenClaw agent through `openclaw_agent_consult`, and treats the result like a typed Discord prompt from that speaker. `stt-tts` keeps the older batch STT plus TTS flow. `bidi` lets the realtime model converse directly while exposing `openclaw_agent_consult` for the OpenClaw brain.
- Realtime voice keeps each speaker's audio in a separate provider connection, so delayed transcripts and tool calls retain that speaker's Discord identity. Everyone still uses the same routed OpenClaw agent conversation and one room playback queue. Direct `bidi` conversation history belongs to each speaker's realtime connection; use the OpenClaw agent consult for shared room history. Multiple speakers can consume more provider connections, and provider account limits still apply. The room retains at most eight speaker connections and reclaims idle connections once their captures, requests, and playback have finished.
- `voice.agentSession` controls which OpenClaw conversation receives voice turns. Leave it unset for the voice channel's own session, or set `{ mode: "target", target: "channel:<text-channel-id>" }` to make the voice channel act as the microphone/speaker extension of an existing Discord text channel session such as `#maintainers`.
- `voice.model` overrides the OpenClaw agent brain for Discord voice responses and realtime consults. Leave it unset to inherit the routed agent model. It is separate from `voice.realtime.model`.
- `voice.followUsers` lets the bot join, move, and leave Discord voice with selected users. See [Follow users in voice](/channels/discord/voice-follow#follow-users-in-voice).
- `agent-proxy` routes speech through `discord-voice`, which preserves normal owner/tool authorization for the speaker and target session but hides the agent `tts` tool because Discord voice owns playback. By default, `agent-proxy` gives the consult full owner-equivalent tool access for owner speakers (`voice.realtime.toolPolicy: "owner"`) and strongly prefers consulting the OpenClaw agent before substantive answers (`voice.realtime.consultPolicy: "always"`). In that default `always` mode, the realtime layer does not auto-speak filler before the consult answer; it captures and transcribes speech, then speaks the routed OpenClaw answer. If multiple forced consult answers finish while Discord is still playing the first answer, later exact-speech answers are queued until playback idles instead of replacing speech mid-sentence.
- Realtime voice buffers generated audio when Discord playback temporarily falls behind and tolerates brief provider or network gaps. Each provider response keeps its own buffered audio, including native tool continuations. Normal backpressure does not cancel the response, and queued answers wait until Discord finishes playing the previous answer, even if its provider response or audio encoder has already finished.
- OpenAI and xAI interruptions truncate each retained native audio item at the amount Discord consumed. Queued items are discarded at zero, and completed replies that have finished playing are left intact. Playback progress survives temporary gaps in the same response; OpenAI's echo guard uses the combined consumed duration of retained items.
- If a speaker's realtime connection fails, other speakers stay connected. Check the `realtime speaker failed` log and try speaking again to open a new connection. If the initial provider connection fails during `/vc join`, joining fails while an already-connected recorder keeps recording; check the `realtime session failed terminally` log and retry `/vc join`. Temporary provider reconnects do not end the Discord voice session.
- In `stt-tts` mode, STT uses `tools.media.audio`; `voice.model` does not affect transcription.
- `stt-tts` replies remain active until Discord finishes playing them; long responses are not cut off by a fixed one-minute playback deadline.
- In realtime modes, `voice.realtime.provider`, `voice.realtime.model`, and `voice.realtime.speakerVoice` configure the realtime audio session. For OpenAI Realtime 2.1 plus the Codex brain, use `voice.realtime.model: "gpt-realtime-2.1"` and `voice.model: "openai/gpt-5.6-sol"`.
- Realtime voice modes include small `IDENTITY.md`, `USER.md`, and `SOUL.md` profile files in the realtime provider instructions by default so fast direct turns keep the same identity, user grounding, and persona as the routed OpenClaw agent. Set `voice.realtime.bootstrapContextFiles` to a subset to customize this, or `[]` to disable it. Only those profile files are supported; `AGENTS.md` stays in the normal agent context. The injected profile context does not replace `openclaw_agent_consult` for workspace work, current facts, memory lookup, or tool-backed actions.
- In OpenAI `agent-proxy` realtime mode, wake-name gating adapts to the room by default: one human can talk naturally without a wake name, while two or more humans must start or end a turn with one. Other bots do not count as people. Set `voice.realtime.requireWakeName: true` to always require a wake name or `false` to never require one. Configured wake names must be one or two words. If `voice.realtime.wakeNames` is unset, OpenClaw uses the routed agent `name` plus `OpenClaw`, falling back to the agent id plus `OpenClaw`. An active wake-name gate disables realtime provider auto-response, routes accepted turns through the OpenClaw agent consult path, and gives a short spoken acknowledgement when an exact leading wake name is recognized from partial transcription before the final transcript arrives. Fuzzy name matching waits for the final transcript, so an unfinished ordinary word does not trigger an acknowledgement. The policy follows live joins and leaves without reconnecting voice.
- The OpenAI realtime provider accepts current Realtime 2 event names and legacy Codex-compatible aliases for output audio and transcript events, so compatible provider snapshots can drift without dropping assistant audio.
- `voice.realtime.bargeIn` controls whether Discord speaker-start events interrupt active realtime playback. If unset, it follows the realtime provider's input-audio interruption setting.
- `voice.realtime.minBargeInAudioEndMs` controls the minimum assistant playback duration before an OpenAI realtime barge-in truncates audio. Default: `250`. Set `0` for immediate interruption in low-echo rooms, or raise it for echo-heavy speaker setups.
- `voice.tts` overrides `tts` for `stt-tts` voice playback only; realtime modes use `voice.realtime.speakerVoice` instead. For an OpenAI voice on Discord playback, set `voice.tts.provider: "openai"` and choose a Text-to-speech voice under `voice.tts.providers.openai.speakerVoice`. `cedar` is a good masculine-sounding choice on the current OpenAI TTS model.
- Per-channel Discord `systemPrompt` overrides apply to voice transcript turns for that voice channel.
- When OpenClaw joins a voice channel, the routed agent session receives a silent system event with the current participant roster. Later participant joins and leaves update that session without triggering an unsolicited spoken reply; Discord display names are treated as untrusted labels. Authorized voice turns also receive a fresh roster snapshot.
- Voice transcript turns and `/vc` commands use Discord entries in `commands.ownerAllowFrom` for owner status. When no Discord command owner is configured, the selected Discord account's `allowFrom` (or legacy `dm.allowFrom`) can still authorize voice access without granting owner status. Agent tool visibility follows the configured tool policy for the routed session.
- If `voice.autoJoin` has multiple entries for the same guild, OpenClaw joins the last configured channel for that guild.
- `voice.autoJoin[].whenOccupied` defaults to `false`. Set it to `true` for an auto-managed room that should contain the bot only while at least one human is present. OpenClaw joins on the first human arrival and leaves after the last human departs; the OpenClaw bot and other bots do not count. Startup, fresh gateway sessions, and resumed gateway sessions reconcile from Discord's voice-state roster.
- Occupancy management owns only sessions that it joined. A manual `/vc join`, standalone transcript-only session, follow-user session, active session in another channel, or other ad-hoc join is not moved or disconnected when the configured room empties. Attaching transcript capture to an occupancy-managed session preserves that ownership.
- `voice.allowedChannels` is an optional residency allowlist. Leave it unset to allow `/vc join` into any authorized Discord voice channel. When set, `/vc join`, startup auto-join, and bot voice-state moves are restricted to the listed `{ guildId, channelId }` entries. Set it to an empty array to deny all Discord voice joins. If Discord moves the bot outside the allowlist, OpenClaw leaves that channel and rejoins the configured auto-join target when one is available.
- `voice.daveEncryption` and `voice.decryptionFailureTolerance` pass through to `@discordjs/voice` join options; the upstream defaults are `daveEncryption=true` and `decryptionFailureTolerance=24`.
- OpenClaw uses the bundled `libopus-wasm` codec for Discord voice receive and realtime raw PCM playback. It ships a pinned libopus WebAssembly build and does not require native opus addons.
- `voice.connectTimeoutMs` controls the initial `@discordjs/voice` Ready wait for `/vc join` and auto-join attempts. Default: `30000`.
- `voice.reconnectGraceMs` controls how long OpenClaw waits for a disconnected voice session to begin reconnecting before destroying it. Default: `15000`.
- In `stt-tts` mode, voice playback does not stop just because another user starts speaking. To avoid feedback loops, OpenClaw does not admit new conversational turns while TTS is playing; an explicitly started capture still records that speech. Speak after playback finishes for the next conversational turn. Realtime modes forward authorized speaker starts as barge-in signals when interruption is enabled.
- In realtime modes, echo from speakers into an open mic can look like barge-in and interrupt playback. For echo-heavy Discord rooms, set `voice.realtime.providers.openai.interruptResponseOnInputAudio: false` to keep OpenAI from auto-interrupting on input audio. Add `voice.realtime.bargeIn: true` if you still want Discord speaker-start events to interrupt active playback. The OpenAI realtime bridge ignores playback truncations shorter than `voice.realtime.minBargeInAudioEndMs` as likely echo/noise and logs them as skipped instead of clearing Discord playback.
- `voice.captureSilenceGraceMs` controls how long OpenClaw waits after Discord reports a speaker has stopped before finalizing that audio segment for STT. Default: `2000`; raise it if Discord splits normal pauses into choppy partial transcripts.
- When ElevenLabs is the selected TTS provider, Discord voice playback uses streaming TTS and starts from the provider response stream. Providers without streaming support fall back to the synthesized temp-file path.
- OpenClaw watches receive decrypt failures and auto-recovers by leaving/rejoining the voice channel after repeated failures in a short window.
- If receive logs repeatedly show `DecryptionFailed(UnencryptedWhenPassthroughDisabled)` after updating, collect a dependency report and logs. The bundled `@discordjs/voice` line includes the upstream padding fix from discord.js PR #11449, which closed discord.js issue #11419.
- `The operation was aborted` receive events are expected when OpenClaw finalizes a captured speaker segment; they are verbose diagnostics, not warnings.
- Verbose Discord voice logs include a bounded one-line STT transcript preview for each accepted speaker segment, so debugging shows both the user side and the agent reply side without dumping unbounded transcript text.
- In `agent-proxy` mode, forced consult fallback skips likely incomplete transcript fragments such as text ending in `...` or a trailing connector like "and", plus complete non-actionable closings like "I'll be right back" or "bye". Requests that mention a closing, such as "write a goodbye email", still reach the agent. Closing detection uses a bounded English-language heuristic; unrecognized wording continues to the agent. Logs show `forced agent consult skipped reason=...` when this prevents a stale queued answer.

## Voice messages

Discord voice messages show a waveform preview and require OGG/Opus audio. OpenClaw generates the waveform automatically, but needs `ffmpeg` and `ffprobe` on the gateway host to inspect and convert.

- Provide a **local file path** (URLs are rejected).
- Omit text content (Discord rejects text + voice message in the same payload).
- Any audio format is accepted; OpenClaw converts to OGG/Opus as needed.

```bash
message(action="send", channel="discord", target="channel:123", path="/path/to/audio.mp3", asVoice=true)
```
