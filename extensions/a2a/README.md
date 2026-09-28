# A2A

Connect OpenClaw to other agents using the Agent2Agent protocol. The plugin
publishes an Agent Card, receives authenticated tasks, and sends messages to
configured peers using A2A 1.0 JSON-RPC.

## Get started

Enable `channels.a2a`, set your public `advertisedUrl`, and configure a separate
bearer token for each trusted peer under `channels.a2a.peers`. Add a peer's URL
and outbound token when OpenClaw should initiate messages to it.

Agent Card discovery is public. Limit `channels.a2a.exposeAgents` if only selected
agents should be advertised.

Peers can submit text tasks, not operator slash commands. Streaming, file
transfer, and task cancellation are not supported.

See the [A2A guide](https://docs.openclaw.ai/channels/a2a) for configuration,
authentication, and task polling.
