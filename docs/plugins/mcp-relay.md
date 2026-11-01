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
ChatGPT, Codex, and Claude connect to `https://mcp.openclaw.ai/mcp`; you do not
need to expose a Gateway port to the internet. In ChatGPT and Codex, OpenClaw
appears in the sidebar with your Gateway's full Control UI, and one connection
can switch between several Gateways.

The plugin is **disabled by default**. Enabling it opts your Gateway into an
outbound relay connection. Each client also needs a grant you authorize through
**Sign in with your Gateway** or a single-use pairing code. Sign-in is optional;
pairing codes remain available.

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

<a id="connect-chatgpt-or-claude" />

## Connect ChatGPT, Codex, or Claude

Add `https://mcp.openclaw.ai/mcp` as a plugin in ChatGPT or a custom connector
in Claude. On the relay's connection page, choose **Sign in with your Gateway**
and enter your Gateway's Control UI URL. Your browser opens the Gateway's
**Connected apps** page, using its normal sign-in. The relay does not fetch your
Gateway URL or receive your Gateway credentials.

Codex shares its MCP servers between the CLI and the desktop app. Add the relay
once, then sign in; the login opens the same relay connection page:

```bash
codex mcp add openclaw --url https://mcp.openclaw.ai/mcp
codex mcp login openclaw
```

Check the app name and return host, select its access, and choose **Allow** or
**Deny**. Both choices return you to the relay to finish the request. Requests
expire after ten minutes. Start again from the app if a request has expired.
Linking another Gateway from an app uses the same consent flow.

The default access is **Read and write**, capped by your current role. **Full
role access** also includes any administration or approval permissions your role
allows. Full access lets the embedded Control UI perform those actions; only
choose it for an app and relay you trust with that authority. An app's access
can never exceed your current Gateway permissions.

### Pair with a code

1. Open **Connected apps** in your Gateway's Control UI and choose **Pair with
   code**. Select the access and create a code. On a single-user Gateway, you can
   also run `openclaw mcp-relay pair` on the Gateway host.
2. On the relay's connection page, verify the app name and return host, enter the
   `XXXXX-XXXXX` code, and connect.

Codes expire after ten minutes and can be used only once. Spaces, hyphens, and
letter case do not matter. Create a new code if it expires. Pairing requires a
connected relay socket; check `openclaw mcp-relay status` if issuing a code fails.
On a Gateway using verified profiles, create codes in **Connected apps** while
signed in as yourself; the CLI refuses to create a person-less grant.

## Connected apps

The **Connected apps** tab lists your grants and their access limits. You can
revoke your own grants; administrators can see and revoke all grants. On
single-user Gateways, operators with administrator access can create owner
grants. On Gateways with verified profiles, each grant belongs to the person
who approved it, including grants approved by an administrator.

## Use several Gateways

One ChatGPT or Codex connection can hold several Gateways, such as a personal
Gateway and a Team Gateway. Each linked Gateway has its own grant, principal, and
access limit, and appears in that Gateway's **Connected apps** tab.

In the embedded Control UI, open the identity menu. Its **Gateway** section lists
the linked Gateways: select one to switch the page, choose **Set as primary**, or
choose **Gateway settings…** to open **Your Gateways**. Without the embedded UI,
the **Gateways** button opens the same dialog. There you can:

- Link a Gateway with **Sign in with Gateway** and its Control UI URL, or with a
  pairing code from that Gateway.
- **Open** a Gateway in the sidebar.
- **Set primary** to choose the Gateway that the model's conversation tools use.
- **Remove** a linked Gateway, which revokes its grant.

The Gateway you connected first cannot be removed from this list. Disconnect the
connector in ChatGPT or Codex, or revoke its grant in that Gateway's **Connected
apps** tab.

### Team Gateways

A Team Gateway using [Cloudflare Access](/gateway/cloudflare-access)
trusted-proxy authentication with configured roles works the same way. **Sign in
with Gateway** opens the Gateway's Control UI behind its usual sign-in, and you
approve the request as yourself. The grant is a person grant tied to your
verified profile, so **Full role access** carries your role into the app,
including administrator access if your role has it. A later role change also
limits the grant. See [Team server](/gateway/team-server) for Gateway setup.

## Show the full Control UI in ChatGPT

After pairing, open OpenClaw in ChatGPT to use your Gateway's full Control UI.
There is no additional plugin configuration: HTTP and WebSocket traffic travel
over the existing outbound relay connection. The Gateway can remain on a private
network. The relay gives each grant separate HTTPS origins for the UI and its
sandbox, and preserves the Gateway's configured Control UI base path.

The plugin requires a current Gateway with principal-bound ingress support.
The relay must also support the UI tunnel. The embedded browser uses the grant's
principal and access limit; it does not receive or store an ordinary paired-device
token. You do not paste the Gateway's shared token or password into ChatGPT.

A single-user Gateway uses an owner grant. A Gateway using trusted-proxy
authentication or configured roles requires a person grant tied to an existing
verified profile. Old owner grants on these Gateways are refused with guidance
to pair again as a person. The same live principal and permissions apply to MCP
operations and the embedded Control UI.

Run `openclaw mcp-relay status` to see UI availability and any update guidance.
Until the first launch, availability checks only whether the Gateway and relay
support the tunnel. If Gateway authentication is unsupported, that first launch
shows the configuration error inside the frame. After correcting the configuration,
open the UI again to retry. A Gateway or relay without tunnel support keeps the
built-in conversations view.

Revoke an app through **Connected apps** to close its embedded browser sessions,
active requests, sockets, and MCP access. The embedded browser does not create
an ordinary device token that needs separate revocation.

**The relay sees UI traffic and content in transit.** TLS protects each
connection, but this is not end-to-end encryption against the relay. Only pair
an app when you trust it and the relay with the access you select.

The Gateway ingress and relay enforce request, socket, buffer, and timeout limits.
The plugin splits payloads into chunks of at most 512 KiB to fit the 1 MiB relay
frame limit. Oversized or stalled work fails explicitly. Disconnecting the relay closes its
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

The MCP conversation operations do not expose arbitrary Gateway methods. Their
requests run as the grant's principal, within both its selected access limit and
the principal's current permissions. The embedded Control UI can use additional
capabilities, including administration and approvals, only when both the grant's
access limit and the principal's current role permit them. Sending messages can
cause the agent to take real actions under its own policies.

## Data and authority

The Gateway generates and persists its own Ed25519 identity in plugin-owned
SQLite state. The relay receives the public key and a signed challenge, never
the configured Gateway token or password or the private key. Pairing-code hashes
and client grants also live in plugin-owned SQLite state and survive Gateway
restarts and updates.

The Gateway authorizes each grant and checks its live authority on every
operation. Grants store an owner or person principal and an operator-scope
ceiling in the plugin's own state. A person's profile ID stays on the Gateway;
the relay receives only the principal kind and display label. Effective access
is the intersection of the ceiling and the principal's current authority, so a
role change also limits existing grants. Grants are not restricted to one
conversation; normal principal and role visibility still applies.

Person grants approved through Gateway sign-in have an absolute refresh-token
lifetime of 30 days. After that, sign in and approve again. Owner grants and
pairing-code grants retain their existing relay token lifetime. Revocation,
plugin disablement, or lost principal authority can end access sooner.

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
output. The CLI requests administrator access for pairing, listing, and revoking
grants; connection status requires operator read access. In **Connected apps**,
listing your own grants requires read access, while pairing and revoking your
own person grants require write access. Creating owner grants or revoking
another person's grant requires administrator access. Grant listings include
the principal and scope ceiling.

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
