# Session Share

Let teammates read selected OpenClaw conversations from another Gateway.
Session Share publishes user and assistant text in a read-only session catalog;
the source operator chooses which session groups to share.

## Get started

Enable the plugin on both machines and configure the source's `share.groups`
with the exact group names to publish. Run the source node using the same user,
state directory, and configuration as its Gateway.

Pair it with the receiver using the guide's two-command allowlist for session
listings and reads. The source must stay connected for browsing.

See the [Session Share guide](https://docs.openclaw.ai/plugins/session-share) for
pairing, viewer permissions, and sharing boundaries.
