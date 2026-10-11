---
summary: "How Talk resolves the owning agent, session key, store, and control authority"
read_when:
  - Running Talk on a multi-agent Gateway
  - Debugging tool authority mismatches or no-active-run responses
  - Closing or replacing a Talk session
title: "Talk session ownership"
sidebarTitle: "Session ownership"
---

## Session ownership

`talk.client.create` and realtime `talk.session.create` resolve their session before
loading profile context or starting a provider. An agent-prefixed `sessionKey`
selects that agent. Otherwise, Talk uses `talk.agentId`, then the configured system
agent or an unambiguous default agent. Without an owner in a multi-agent Gateway,
set `talk.agentId` or send an agent-prefixed key.

`talk.catalog` also requires an unambiguous Talk owner and checks it before
discovering providers, so missing ownership returns its setup error promptly.

Omitting `sessionKey` selects the same owned main session as a bare `main` key;
both enforce sharing, incognito, and operator-role restrictions. Main aliases
honor `session.scope` and the configured [main session](/concepts/main-session) key. A shared fixed store retains
its recorded owner for unqualified keys, and conflicting explicit ownership is rejected
even when a main alias becomes `global`. If routing or access changes during
startup, creation fails rather than switching sessions; retry the request.

Client tool calls, Gateway-owned provider consultations, and steering retain the prepared agent,
canonical session key, and store. Agent replies stay in the same session as voice
transcripts, including under global scope, while the original key continues to
identify the voice call. Provider-attached controls and `talk.session.steer` select
only work bound to that logical voice call. Reusing `voiceSessionId` to replace a
browser transport preserves control of its accepted work. The legacy
`talk.client.steer` RPC remains session-scoped: it selects owned work by
`sessionKey`, not by a voice call ID.

Native steering uses the current caller's tool policy and session permissions. The
host captures the actual backend attempt's authority after policy preparation and
checks that exact owner again before delivering a control. Changed caller authority, tool
allowlists, permission modes, or closed/replaced attempts can produce
`tool_authority_mismatch`; a run ID or copied fingerprint does not authorize steering.
Direct voice input does not acquire trace or client-tool capabilities. Chat-backed
Talk keeps the authenticated caller's normal chat authority, including its reviewer
and client capabilities, but disables task suggestions because Talk cannot accept
them. Status and cancellation do not require a tool-policy projection. Controls
capture their target before queue or transcript waits; they never move to a task
that starts later. A control received before backend registration returns a visible
no-active-run response rather than waiting for an unrelated future task.

When a source-bound native control is routed to a pending question, its answer
or image-triggered cancellation is checked again immediately before Gateway
dispatch, after registration, input persistence, and connection preparation.
Closing or reassigning the source before that check rejects the stale input
without cancelling the independent backing question or run; a later valid
answer can still use the same question. An answer already consumed by the
question remains accepted if the source closes while its response returns.
Delayed confirmation uses the question's existing deadline. If confirmation is
lost entirely, Talk reports that it could not confirm the input and does not send
it again as steering; check the conversation before retrying.
This applies to controls routed through pending-question input, not universal
interception of spoken answers by every voice provider.

Managed-room handoffs do not yet supply current-speaker tool authority. Room
attachment alone cannot authorize steering; status and cancellation remain available.

Keep the original `sessionKey` for client transcript, tool-call, and close requests.
`talk.client.close` requires both that exact key and the returned `voiceSessionId`;
an equivalent storage alias is not a replacement. A `talk.client.toolCall` acknowledgement
returns `agentId`, `agentSessionKey`, and `runId`; use that exact target for chat
cancellation, history, and completion events, including when the canonical key is `global`. Transcription-only sessions
without a key remain sessionless and do not select a default chat.
