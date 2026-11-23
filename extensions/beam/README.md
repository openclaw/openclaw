# Beam

Share coding-session snapshots with trusted Gateway operators. Beam
receives authenticated uploads and displays them in the Control UI's session
catalog. Restricted guests with a verified profile and current Visitor invitation
can publish, refresh, and view their own snapshots while their invitation is active,
without access to other publishers' snapshots or the shared catalog. Operators can
read a snapshot or copy its history into a separate conversation to continue the work.

## Get started

Enable Beam on the receiving Gateway:

```bash
openclaw plugins enable beam
```

The sender needs a reachable Gateway endpoint and permission to upload. Review the transcript before sending it: conversation text is preserved,
including any secrets it contains. Snapshots provide conversation context
without access to the source computer or its tools.

See the [Beam guide](https://docs.openclaw.ai/plugins/beam) for sender setup,
authentication, visibility, and optional mirroring.
