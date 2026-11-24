# Beam

Share coding-session snapshots with trusted Gateway operators. Beam
receives authenticated uploads and displays them in the Control UI's session
catalog. Restricted guests with a verified profile and current Visitor invitation
can publish, refresh, and view their own snapshots while their invitation is active,
without access to other publishers' snapshots or the shared catalog. To hand off a
conversation, the original verified publisher releases the snapshot. The first
authorized continuation seeds one Team conversation. Reopening the Beam link
returns to that conversation if the viewer still has access.

## Get started

Beam ships with OpenClaw and is disabled by default. Enable it on the receiving
Gateway:

```bash
openclaw plugins enable beam
```

If the Gateway is offline, start it after enabling Beam. The sender needs a
reachable Gateway endpoint and permission to upload. Review the transcript
before sending it. Conversation text is preserved,
including any secrets it contains. Snapshots provide conversation context
without access to the source computer or its tools.

See the [Beam guide](https://docs.openclaw.ai/plugins/beam) for sender setup,
authentication, visibility, and optional mirroring.
