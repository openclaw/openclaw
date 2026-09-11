---
summary: "Voice selection from chat, realtime delegation, steering, transcripts, and browser Talk behavior"
read_when:
  - Wiring a realtime Talk client or a Gateway-controlled call
  - Changing voice selection, steering, or transcript handling
  - Debugging browser Talk microphone or transcription errors
title: "Talk realtime sessions and delegation"
sidebarTitle: "Realtime sessions"
---

## Choose a Talk voice from chat

After setting `talk.provider` and the matching `talk.providers.<provider>` configuration, use `/voice status` to inspect the active provider and voice, `/voice list [limit]` to list its available voices, and `/voice set <voiceId|name>` to save a provider-scoped selection. Discord exposes the same command natively as `/talkvoice`.

Status and list are read-only. Setting a voice requires the message-channel owner or a Gateway client with `operator.admin`. Configuration, provider lookup, unknown-voice, and permission failures are returned visibly in chat. A masked API-key value in `/voice status` describes config only; it does not verify credential availability.

Client-owned realtime Talk normally forwards provider tool calls through `talk.client.toolCall` instead of calling `chat.send` directly. GPT-Live WebRTC sessions delegate on a Gateway-owned sideband, and the Gateway binds each delegation to the browser or Gateway-relay Talk session that owns it. Backend WebSocket bridges use the normal relay consult path. While a realtime consult is active, clients can call `talk.client.steer` or `talk.session.steer` to classify spoken input as `status`, `steer`, `cancel`, or `followup`; this includes GPT-Live delegations. Accepted steering queues into the active embedded run; rejected steering returns a reason such as `no_active_run`, `not_streaming`, or `compacting`. A newer GPT-Live spoken task also supersedes the running delegation.

Thin audio clients can request `gateway-control-v1` in
`talk.client.create.capabilities`. OpenAI GA Realtime requires a Platform API
key for this mode. The released GPT-Live route keeps its existing ChatGPT OAuth
or Platform authentication; unlisted routes require Platform authentication.
Requesting Gateway control does not switch the selected model.

Success returns `clientControl: { owner: "gateway" }`, a 60-second single-use
`clientSecret`, and the relative offer URL `/plugins/openai/realtime/calls`.
The client posts an audio-only SDP offer and opens no provider data channel.
The Gateway attaches the provider's server sideband and owns tools or native
agent delegation, transcripts, steering, cancellation, and call cleanup while
media continues directly between the client and OpenAI. Negotiated sessions
share a two-session limit per client connection, including pending offers.
Unsupported combinations, including GA with OAuth only, fail visibly instead
of falling back to client-owned control. Existing browser clients omit this
capability and keep their data channel and client transcript reporting.

In Gateway-controlled native calls and native Gateway relays, the provider's
delegation starts each host action. Final speech transcripts are saved to history;
they neither trigger actions nor repeat a delegation's action. Status keeps the
current task running, cancellation stops it, and redirects or follow-ups target
that call's active work. When the call has no active task, status and cancellation
return a spoken no-active-run response, even if another call on the same connection
and agent session has work in progress. Ordinary requests such as “Check the
weather” still start tasks while idle. Genuine new tasks retain the native
delegation replacement behavior.

These calls disable provider-generated delegation acknowledgments at creation.
OpenClaw sends one neutral receipt when it launches a real task; status and
cancellation requests wait for the host result instead, without waiting for final
speech transcription. A full control queue produces a spoken refusal; retry after
the pending controls finish. A task receipt is not confirmation that a model or
tool has started, and submitting a spoken result is not proof of audible delivery.

Closing a native transport fences new delegations and late provider delivery;
already accepted agent work retains its own cancellation lifetime. Spoken run
cancellation is separate from ending the audio connection. Gateway-controlled
native sessions acknowledge cancellation without speaking the canceled task's
partial answer, empty-result fallback, or failed-task retry prompt. Timeouts
remain failures rather than being silently treated as cancellations.

Finalized realtime user and assistant utterances are always appended live to the active agent session, so later chat and voice turns share one history. Client-owned transports report their finalized transcripts with stable entry ids; Gateway relay and Gateway-controlled WebRTC sessions append the same events server-side. Provider sessions also receive the bounded realtime profile context used by Discord voice.

Gateway-controlled native WebRTC calls receive shared-session history as quoted
historical background in their instructions, not as the new call's own user or
assistant messages. This background can include prior calls and backing-agent
answers; it does not establish the current call's live task state. It retains
the newest history within 16 entries, 800 characters per entry, and 8,000 UTF-8
bytes including labels and quoting. This changes neither saved transcripts nor
chat display. Native calls without negotiated host input control and direct
WebSocket conversation seeds keep their existing representation.

Generated agent-consult prompts are internal input, not spoken user turns. New
consult records are hidden from chat and excluded from later model context, while
the active consult still receives the full question, context, and response style.
Raw archives and [session exports](/tools/slash-commands) remain lossless. Existing
consult records without the exclusion flag are not rewritten and remain eligible
for model context.

Chat-backed Talk stores the spoken answer without a second copy of the
successful consult answer in visible history; the internal answer remains in the
raw transcript and model context. Tool activity, progress, errors, and interrupted
replies retain their existing visibility.

Direct provider-owned consultations keep their own final answer visible in Chat.
Accepted work can outlive a closed or replaced audio connection, so a spoken
replacement is not guaranteed. If speech also arrives, both records may be visible;
OpenClaw preserves the answer rather than guessing that the spoken text replaces it.

OpenAI GA browser Talk keeps provider conversation order even when an assistant
reply finishes before the user's transcription or item announcements arrive out
of order. Text streams immediately in the call view; late predecessor metadata
places it beside the correct reply. Stopping a call drains finalized speech,
skips unfinished transcriptions, and records a browser console warning for
missing transcriptions or unresolved conversation links.

Google Live saves complete utterances during the call, including Gemini 3.1
transcriptions that omit an explicit transcription-finished flag. Partial text
stays provisional until the provider's completion boundary.

Voice-originated consult runs require a new, exact spoken confirmation before high-impact actions such as sending messages, controlling nodes, browser/computer actions, service changes, destructive shell commands, or publication. The gate applies to runs started through `talk.client.toolCall`, the Gateway relay, and GPT-Live sideband delegations. The confirmation applies only to the canonical final execution arguments and is consumed once; if a policy or hook rewrites the approved action, OpenClaw blocks it until the rewritten action is confirmed. Unrelated concurrent runs remain unaffected. When a call closes, OpenClaw can send a compact **Voice call changes** digest for mutating tools to the session's last non-WebChat delivery target.

Transcription-only Talk emits the same Talk event envelope as realtime and STT/TTS sessions, but uses `mode: "transcription"` and `brain: "none"`. All Talk sessions broadcast events on the `talk.event` channel; clients subscribe to it for partial/final transcript updates (`transcript.delta`/`transcript.done`) and other session telemetry.

Transcription providers can advertise their model choices in `talk.catalog.transcription.providers[].models`. Pass `model` to `talk.session.create` to override the configured transcription model for that session. Omitting it keeps the provider configuration, then the matching `agents.defaults.voiceModel`, then the provider's own default.

Browser Video Talk is available for OpenAI Realtime WebRTC and Google Live
provider-WebSocket sessions. OpenAI gets a single bounded JPEG when
`describe_view` asks for visual context; it does not receive a continuous
camera track. Google Live receives bounded JPEG frames directly from the
browser at up to one frame per second, while `describe_view` reports the
camera-stream state. In both cases, camera frames bypass the Gateway, and
stopping Talk releases the camera and microphone tracks.

Browser Talk shows startup progress while preparing the session, waiting for
microphone access, and connecting. Talk and dictation show microphone guidance
while the browser's capture request is pending: bring the tab to the foreground
and allow access if prompted. The browser can keep an unanswered permission
request pending. In Talk, **Stop voice input** cancels startup and releases any
microphone stream granted after cancellation.

Browser Talk acquires the microphone before creating the provider session, so
time spent granting permission does not consume a short-lived connection token.
If session creation fails, Talk releases the microphone before reporting the error.

If OpenAI cannot transcribe an utterance, browser Talk shows the provider's error
without ending the call or inventing a transcript. You can speak again; audio
responses continue independently of input transcription.

If the microphone disconnects or its permission is revoked, browser Talk ends
the call and shows an error. Choose an available **Microphone input**, restore
permission if needed, and start Talk again. An unexpected GPT-Live connection
loss also ends the call with an error; automatic reconnection is not supported.
