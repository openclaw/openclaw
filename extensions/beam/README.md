# Beam

Share sanitized coding-session snapshots with trusted Gateway operators. Beam
receives authenticated uploads and displays them in the Control UI's session
catalog. Operators can read a snapshot or copy its history into a separate
conversation to continue the work.

## Get started

Enable Beam on the receiving Gateway:

```bash
openclaw plugins enable beam
```

The sender needs a reachable Gateway endpoint and permission to upload. Prepare
and redact the transcript before sending it. Snapshots provide conversation
context without access to the source computer or its tools.

See the [Beam guide](https://docs.openclaw.ai/plugins/beam) for sender setup,
authentication, visibility, and optional mirroring.
