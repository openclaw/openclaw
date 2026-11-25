---
summary: "Slack huddles plugin: join active huddles through a signed-in Chrome user account"
doc-schema-version: 1
read_when:
  - You want an OpenClaw agent to join a Slack huddle
  - You need to set up the dedicated Slack user or understand manual actions
title: "Slack huddles plugin"
---

The `slack-huddles` plugin joins active Slack huddles through the Slack web client
in the OpenClaw Chrome profile. It uses a dedicated Slack **user account** for
the agent: Slack has no app or bot API for joining huddles or reading their audio.
The plugin is separate from the [Slack messaging channel](/channels/slack).

Use [Meeting plugins](/plugins/meeting-plugins) for shared modes, Chrome and
virtual-audio setup, transcripts, remote-node requirements, and verification.

## Requirements

- OpenClaw 2026.9.8 or newer. Older hosts lack the shared meeting-runtime
  ownership checks this plugin depends on, so install refuses them.
- A dedicated Slack user account signed into Slack in the OpenClaw Chrome profile.
- Membership in the channel or conversation containing the huddle.
- An active huddle, started by a person in Slack.
- Slack's English UI. The adapter prefers `data-qa` hooks, but its text and
  accessible-label fallbacks are English-only.
- For talk-back (`agent` or `bidi`), BlackHole 2ch and SoX on macOS, or
  PipeWire-Pulse and its command-line tools on Linux, on the host that runs Chrome.

For caption transcripts, turn on Slack's preference to **turn on captions by
default when joining huddles** for the dedicated account. The plugin reads
visible captions; it does not open Slack menus to enable them. When captions are
unavailable, status reports `captioning: false` with a note. Caption availability
also limits the shared durable transcript and notes path.

## Install and enable

Install the plugin if needed, then enable it explicitly:

```bash
openclaw plugins install @openclaw/slack-huddles
openclaw plugins enable slack-huddles
```

It is disabled by default because it needs a signed-in dedicated Slack user.
Check that the configuration change applies, then verify prerequisites:

```bash
openclaw slackhuddles setup
```

Sign in using the same Chrome profile that OpenClaw controls. A Slack app's bot
token or user OAuth token does not replace that browser sign-in.

Talk-back verifies Slack's selected microphone label: BlackHole 2ch on macOS or
the OpenClaw Meeting Audio source on Linux. When needed, the adapter opens
Slack's audio settings and selects that microphone before enabling in-call
talk-back. If the picker is unavailable, select it manually and retry status.
Verify remote audibility with a controlled second participant.

## Configure

The plugin uses the shared meeting configuration. This example uses the normal
agent path and Chrome on a paired node:

```json5
{
  plugins: {
    entries: {
      "slack-huddles": {
        enabled: true,
        config: {
          defaultMode: "agent",
          chrome: {
            browserProfile: "openclaw",
            autoJoin: true,
            audioBackend: "auto",
          },
          chromeNode: { node: "meeting-node" },
        },
      },
    },
  },
}
```

Omit `chromeNode` to run Chrome on the Gateway host. A paired node must allow
`browser.proxy` and `slackhuddles.chrome`; select it with
`plugins.entries.slack-huddles.config.chromeNode.node`.

Use `agent` for OpenClaw reasoning and tools with TTS replies, `bidi` for direct
realtime voice, or `transcribe` for observe-only captions. Talk-back captures
remote participant audio in the page and sends assistant speech through the
virtual microphone. Configure providers using the
[shared meeting settings](/plugins/meeting-plugins#configure-teams-or-zoom).
The Slack account owns the display name; a guest name is not entered.

## Join and manage a huddle

In Slack, use **Copy huddle link**, then pass the link to OpenClaw:

```bash
openclaw slackhuddles join 'https://app.slack.com/huddle/T0123ABCD/C0123ABCD'
openclaw slackhuddles status
openclaw slackhuddles leave <session-id>
```

A channel reference also works. Without a workspace id, the signed-in Slack
client resolves its active workspace:

```bash
openclaw slackhuddles join 'channel:C0123ABCD' --mode transcribe
```

Accepted inputs are HTTPS Slack huddle links with or without the team id, and
channel ids beginning with `C`, `G`, or `D`, followed by at least eight uppercase
letters or digits. Channel references can be prefixed with `channel:` or
`slack:channel:`. To select a workspace explicitly, use
`team:T0123ABCD:channel:C0123ABCD` or
`slack:team:T0123ABCD:channel:C0123ABCD`; both produce
`https://app.slack.com/huddle/T0123ABCD/C0123ABCD`. Team ids begin with `T` or `E`
and follow the same uppercase and length rules.

Message permalinks, user ids, `slack://` deep links, and Slack `/client/...`
browser URLs are not accepted join inputs. Use **Copy huddle link** or a channel
reference. Channel ids are only unique within a workspace, so a team-qualified
link keeps its workspace: it reuses a session only for the same workspace and
channel, and never matches a bare channel reference.

The `slack_huddles` tool supports `join`, `leave`, `status`, `transcript`, and
`speak`. Its join `url` can be a huddle link or channel reference. In a Slack
conversation, the **Conversation info** `chat_id` carries the channel id.
Gateway methods use `slackhuddles.*`; the node command is `slackhuddles.chrome`.
The transcript source provider is `slack-huddle`, with alias `slack-huddles`;
stored transcripts use the provider name **Slack huddle**.

## Handle manual actions

With `chrome.autoJoin: true`, the adapter clicks **Join Huddle** for an active
huddle, and only while the account is not already in another huddle. It always
joins muted, because the Join transition itself can switch Slack's input. For
talk-back, it selects the virtual microphone in the call and unmutes only once
Slack reports it as the input, so the host's physical microphone never goes
live; `transcribe` stays muted. The camera stays off.

| Reason                        | Action                                                                                                                |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `slack-login-required`        | Sign the OpenClaw Chrome profile into the dedicated Slack account, then retry.                                        |
| `slack-huddle-not-active`     | No one is in this huddle yet. Start the huddle in Slack, then ask again.                                              |
| `slack-confirmation-required` | Read and complete the reported confirmation in Slack. The plugin does not confirm switching huddles or other prompts. |
| `slack-session-conflict`      | The account is already in another huddle, in this browser or on another device. Leave it, then retry.                 |
| `slack-admission-required`    | Complete the request-to-join step and wait for admission. Refresh status after admission.                             |
| `slack-permission-required`   | Resolve the browser microphone permission prompt in the OpenClaw Chrome profile.                                      |

Leave uses Slack's **Leave Huddle** control. It never ends the huddle for everyone.

## Limits

The plugin joins active huddles only. It does not start huddles, answer incoming
rings, automatically join occupied channels, or use screen sharing, canvas,
AI notes, or emoji controls. Use one huddle per dedicated Slack account; another
device using that account can cause a session conflict.

Slack keeps a huddle running while its client shows other channels, so the
adapter proves membership only from the huddle channel's own header. Keep the
OpenClaw Slack tab on that channel: on any other view, status reports the call
as unverified, and audio, captions, and Leave stay blocked.

Slack does not sanction automated user clients. Web-client DOM changes can
break the adapter even when Slack's messaging APIs remain unchanged. This
integration does not create audio or video recordings.

## Related

- [Meeting plugins](/plugins/meeting-plugins)
- [Slack channel](/channels/slack)
- [Transcripts CLI](/cli/transcripts)
