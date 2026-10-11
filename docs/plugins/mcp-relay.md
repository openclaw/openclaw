---
summary: "Connect ChatGPT and Claude to your Gateway through the opt-in MCP relay plugin"
read_when:
  - Connecting a remote MCP client to your OpenClaw Gateway
  - Pairing or revoking a ChatGPT or Claude connector
  - Showing the full Control UI in ChatGPT
title: "MCP Relay"
---

# MCP Relay

The bundled `mcp-relay` plugin connects your Gateway to
`https://mcp.openclaw.ai` over an outbound WebSocket. Remote MCP clients such as
ChatGPT and Claude connect to `https://mcp.openclaw.ai/mcp`; you do not need to
expose a Gateway port to the internet.

The plugin is **disabled by default**. Enabling it opts your Gateway into an
outbound relay connection. Each client also needs a grant authorized with a
single-use code issued by your running Gateway.

## Set up the Gateway

Enable the bundled plugin, then inspect its live connection:

```bash
openclaw plugins enable mcp-relay
openclaw mcp-relay status
```

If the Gateway is stopped, start it before running the status command. Plugin
enablement normally applies to the running Gateway; follow any restart or
reload instruction printed by the command. See
[Apply changes and inspect](/plugins/manage-plugins#apply-changes-and-inspect).

The default relay needs no plugin configuration. To select a different relay
or a default agent, use:

```json5
{
  plugins: {
    entries: {
      "mcp-relay": {
        enabled: true,
        config: {
          relayUrl: "https://mcp.openclaw.ai",
          agentId: "main",
        },
      },
    },
  },
}
```

`relayUrl` must be an HTTPS origin without credentials, a path, query, or
fragment. Local development also accepts `http://localhost:<port>` and
`http://127.0.0.1:<port>`. `agentId` is optional and selects the default agent for
new conversations when the client does not choose one.

## Connect ChatGPT or Claude

1. Run `openclaw mcp-relay pair` on the Gateway host. The command prints a
   `XXXXX-XXXXX` code, its expiration time, and the MCP URL.
2. In **ChatGPT**, open **Plugins**, choose the option to add a plugin, and add
   `https://mcp.openclaw.ai/mcp`. In **Claude**, add a **custom connector** with
   that URL.
3. On the OpenClaw consent page, verify the client name and redirect host, then
   enter the pairing code and connect.

Codes expire after ten minutes and can be used only once. Spaces, hyphens, and
letter case do not matter. If a code expires, run `openclaw mcp-relay pair`
again. Pairing requires a connected relay socket; check
`openclaw mcp-relay status` if issuing a code fails.

## Show the full Control UI in ChatGPT

After pairing, open OpenClaw in ChatGPT to use your Gateway's full Control UI.
There is no additional plugin configuration: HTTP and WebSocket traffic travel
over the existing outbound relay connection. The Gateway can remain on a private
network. The relay gives each grant separate HTTPS origins for the UI and its
sandbox, and preserves the Gateway's configured Control UI base path.

This requires a current Gateway and relay, with Gateway authentication set to
**token** or **password** and no `gateway.roles` configuration. You do not paste
the Gateway's shared token or password into ChatGPT. The browser signs the normal
device challenge and becomes an ordinary paired device with `operator.read` and
`operator.write` scopes. The embedded UI cannot administer the Gateway, approve
commands, or resolve approval prompts; use your direct OpenClaw connection for
those actions.

Run `openclaw mcp-relay status` to see UI availability and any update guidance.
Until the first launch, availability checks only whether the Gateway and relay
support the tunnel. If Gateway authentication is unsupported, that first launch
shows the configuration error inside the frame. Later launches use the built-in
conversations view until a plugin restart or configuration reload clears the
cached error. A Gateway or relay without tunnel support also keeps the built-in
conversations view.

The browser appears in the ordinary **Devices** list. To revoke its device token,
use **Devices** through your direct OpenClaw connection, or
`openclaw devices revoke --device <id> --role operator`. Revoking the MCP relay
grant closes its UI path and active requests and sockets, but does not revoke
ordinary device tokens or delete paired devices. Those tokens also work on the
Gateway's direct listener at their issued read/write scopes; revoke the device
token separately when needed.

**The relay sees UI traffic in transit**, including device tokens and content.
TLS protects each connection, but this is not end-to-end encryption against the
relay. Only pair a client when you trust it and the relay with read/write access
to your Gateway.

The tunnel applies these limits per Gateway relay connection; stricter Gateway
and endpoint limits still apply:

| Resource                                            | Limit                              |
| --------------------------------------------------- | ---------------------------------- |
| Concurrent HTTP requests                            | 64                                 |
| UI WebSockets, including pending opens              | 8                                  |
| HTTP request body                                   | 16 MiB                             |
| Raw payload per tunnel chunk                        | 512 KiB, within a 1 MiB JSON frame |
| Queued response data and partial WebSocket messages | 32 MiB combined                    |
| HTTP response-head wait                             | 60 seconds                         |
| WebSocket-open wait                                 | 10 seconds                         |

Oversized or stalled work fails explicitly. Disconnecting the relay closes its
active requests and sockets. Sandbox-origin WebSocket opens are refused; the
sandbox serves only its dedicated HTTP content.

## Available operations

A paired client can inspect Gateway and agent status, list conversations with
titles and previews, read pages of user and assistant messages, and send messages
to an existing or new conversation. Conversation IDs are opaque Gateway session
keys. Text results are truncated to 16,000 characters per field, and each
response stays below 512 KiB.

Sending a message or requesting a reply can wait up to 50 seconds. If the run is
still active, the client receives `running` and can request the reply again with
the returned conversation and run IDs. Messages use ordinary operator input;
the transcript does not add a distinct `mcp-relay` source label.

Replies come from the run's terminal reply snapshot. A successful run with no
visible reply completes without reply text. If that snapshot is no longer
available, the result is `completed` with an error directing the client to use
`read_conversation` to see the conversation history. The plugin does not
reconstruct replies from transcript pages.

This version cannot distinguish a run waiting for approval from another active
run. It continues to report `running`; it never reports `waiting_for_approval`.
If progress stalls, open the conversation in OpenClaw and check for an approval
prompt.

The MCP conversation operations cannot change Gateway configuration, approve
commands, resolve agent approval prompts, or invoke arbitrary Gateway methods.
These restrictions remain when the full Control UI is available. Sending a
message acts as the Gateway owner: the agent can take real actions under its own
policies, and its approval prompts must still be answered through your direct
OpenClaw connection.

## Data and authority

The Gateway generates and persists its own Ed25519 identity in plugin-owned
SQLite state. The relay receives the public key and a signed challenge, never
the configured Gateway token or password or the private key. Pairing-code hashes
and client grants also live in plugin-owned SQLite state and survive Gateway
restarts and updates.

The Gateway authorizes each grant and checks it on every data operation. A
grant is broad access to the operations above and, when available, the read/write
Control UI; it is not limited to a single conversation. Only pair clients you
trust with that access.

**This connection is not end-to-end encrypted.** TLS protects each network
connection, but the relay sees request and response content in transit. The
relay is designed not to store or log message content; it stores client
registrations and the token, pairing, and grant metadata needed for routing and
authorization. See the [relay privacy policy](https://mcp.openclaw.ai/privacy).
A compromised relay could use existing grants to access the allowed operations.

## Inspect, revoke, or disable

```bash
openclaw mcp-relay status
openclaw mcp-relay grants
openclaw mcp-relay revoke <grantId>
```

These commands act on the running Gateway. Add `--json` for machine-readable
output. Pairing, listing grants, and revoking grants require operator admin
access; connection status requires operator read access.

Revocation is persisted locally before the Gateway notifies the relay. If the
relay is offline, the Gateway still refuses further requests using that grant;
the command reports whether the relay was notified. A revoked client must pair
again to regain access.

To disconnect all clients, disable the plugin:

```bash
openclaw plugins disable mcp-relay
```

Disabling stops the outbound connection. It preserves identity and grant state;
revoke grants first if you want their access to remain revoked after re-enabling
the plugin.

## Related

- [Manage plugins](/plugins/manage-plugins)
- [Control UI](/web/control-ui)
- [Devices](/cli/devices)
- [Operator scopes](/gateway/operator-scopes)
- [Gateway security](/gateway/security)
