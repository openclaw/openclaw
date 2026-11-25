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

## Package the native cleaner

OpenClaw's release packager stages the six cleaner executables listed in
`beamNativeRelease` in this plugin's `package.json`. It verifies each gzip
archive and its executable against their pinned sizes and SHA-256 digests.
The installed plugin selects its platform's executable when outbound cleaning
is first requested. Receiving and viewing snapshots work independently.

To prepare an offline package, warm the cache on a connected build host:

```bash
node extensions/beam/scripts/package-cleaners.mjs --prefetch
```

Copy the complete `.artifacts/beam-cleaners/<version>/` directory to the
same location in the packaging checkout. The normal npm package cache must
also contain the dependency metadata and tarballs required by OpenClaw's
packager. Run the release packaging command with `npm_config_offline=true`.
A missing or changed cleaner archive stops packaging before npm writes its
tarball.

When upgrading the cleaner, verify the Beam release's `cleaners.json` against
its published checksums and provenance. Copy its contents into
`beamNativeRelease` and refresh the Beam section of `THIRD_PARTY_NOTICES.md`
from that release's `CLEANER-NOTICE.txt`.
