---
summary: "Deploy a shared team Gateway with Cloudflare Access, verified GitHub identities, roles, session sharing, and recoverable operations"
read_when:
  - Deploying an always-on OpenClaw server for a trusted team
  - Connecting Cloudflare sign-in to Gateway profiles and GitHub identities
  - Operating separate collaboration and release Gateways
title: "Deploy a team server"
---

This guide connects the pieces of a production team deployment: a persistent
Gateway, Cloudflare Tunnel and Access, individual sign-in, GitHub identity,
operator roles, and optional read-only sharing from another Gateway. Start with
one server. Add a separate release or staging server when it needs different
credentials, update timing, or operators.

For the shorter collaboration walkthrough, see [Team setup](/start/teams).
This guide uses `team.example.com` for collaboration and
`release.example.com` for an optional second Gateway. Replace them with your
own hostnames; each Gateway needs its own configuration and state.

## Before you begin

- A Linux host with persistent storage and a dedicated service account. Use a
  [supported Node runtime](/install/node) and an [OpenClaw installation](/install).
- A Cloudflare-managed domain, Zero Trust account, and `cloudflared` on the host.
- An identity provider and an explicit policy for who may sign in.
- Model credentials and, if needed, a bot account for your team chat.
- Administrative SSH access, a private secret store, and a backup destination
  outside the server's failure domain.

A Gateway is one trust boundary. Roles and session ownership support
collaboration; they do not isolate hostile users from each other. Keep untrusted
code in sandboxes or remote workers. Use separate Gateways, OS users, or hosts
for mutually untrusted teams. See [Multi-tenant hosting](/gateway/multi-tenant-hosting).

## 1. Install under one service account

Complete [Getting started](/start/getting-started) as the account that will run
the Gateway, including model setup and managed-service installation:

```bash
openclaw onboard --install-daemon
openclaw gateway status --deep
```

Keep subsequent configuration, backup, and update commands under that same
account. Running setup as root later creates a different home and can select a
different Gateway. Preserve any custom `OPENCLAW_STATE_DIR`,
`OPENCLAW_CONFIG_PATH`, and profile selector in the service and maintenance
environment. On Linux, verify that the user service remains available after
logout; see [Gateway service management](/cli/gateway/service).

Allow SSH only from your administrative network. Keep the Gateway on loopback
and do not open TCP 18789 publicly. The Cloudflare Tunnel makes an outbound
connection; it does not need an inbound Gateway firewall rule.

Choose an agent ID, such as `assistant`, and use it consistently in channel
bindings and role agent lists. The examples below assume that agent already
exists. Keep shared workspace instructions concise and keep deployment secrets
out of `AGENTS.md`, `IDENTITY.md`, and personal instructions.

## 2. Configure the public URL and authenticated ingress

Create an Access application for `team.example.com` before exposing the tunnel.
Initially admit only the administrators who will finish setup. Choose an Access
policy backed by your intended identity provider; do not create a public bypass
for the Control UI or its WebSocket.

Follow [Cloudflare Tunnel and Access](/gateway/cloudflare-access) to create the
tunnel and DNS record. Its ingress should route only the chosen hostname to the
loopback Gateway:

```yaml
tunnel: <tunnel-id>
credentials-file: /etc/cloudflared/<tunnel-id>.json
ingress:
  - hostname: team.example.com
    service: http://localhost:18789
  - service: http_status:404
```

Protect the tunnel credential file and run `cloudflared` as a service. Preserve a
private local maintenance password using a [SecretRef](/gateway/secrets); the
example below expects `OPENCLAW_GATEWAY_PASSWORD` to be available to both the
Gateway service and the owning account's CLI. Do not distribute that password to
teammates: local password access represents the shared owner.

Merge the following into the existing configuration, preserving your agents,
models, and channels:

```json5
{
  gateway: {
    mode: "local",
    bind: "loopback",
    publicOrigin: "https://team.example.com",
    trustedProxies: ["127.0.0.1", "::1"],
    auth: {
      mode: "trusted-proxy",
      password: { source: "env", provider: "default", id: "OPENCLAW_GATEWAY_PASSWORD" },
      identityScopes: {
        "admin@example.com": ["operator.admin"],
      },
      trustedProxy: {
        userHeader: "cf-access-authenticated-user-email",
        requiredHeaders: ["cf-access-jwt-assertion"],
        allowLoopback: true,
        deviceAutoApprove: {
          enabled: true,
          scopes: ["operator.read", "operator.write", "operator.approvals", "operator.questions"],
        },
      },
    },
    roles: {
      default: "observer",
      definitions: {
        observer: {
          sessions: { others: "view" },
          agents: [],
          scopes: ["operator.read"],
        },
        member: {
          sessions: { others: "write" },
          agents: ["assistant"],
          scopes: ["operator.read", "operator.write", "operator.approvals", "operator.questions"],
        },
        administrator: {
          sessions: { others: "write" },
          agents: "*",
          scopes: ["operator.admin"],
        },
      },
    },
  },
}
```

Remove any earlier `gateway.auth.token` and `OPENCLAW_GATEWAY_TOKEN` when switching
to trusted-proxy auth: a shared token is incompatible with this mode. The private
local password fallback is supported. Validate the configuration, then use the
owning service's lifecycle to activate setup changes:

```bash
openclaw config validate --json
openclaw gateway restart
openclaw gateway status --deep
```

`allowLoopback` trusts local processes as well as `cloudflared`. OpenClaw checks
the proxy source and required headers; their presence is not Access JWT
signature verification. The external authentication boundary is Access plus the
private origin. Do not run hostile workloads with access to this listener. See
[Trusted-proxy auth](/gateway/trusted-proxy-auth) for header and client-address
requirements.

<a id="set-both-url-settings" />

### Set the public URL once

`publicOrigin` tells OpenClaw which external URL to advertise and supplies the
default browser-origin allowlist. For a Control UI served from that same origin,
leave `gateway.controlUi.allowedOrigins` unset.

Set an explicit `allowedOrigins` list only when you need a different browser
policy, such as a separately hosted Control UI. An explicit list replaces the
public-origin default; include the public origin too if both should connect.
An explicit empty list does not inherit `publicOrigin`. Existing local and
private-network origin rules still apply.

Without `gateway.publicOrigin`, the browser can work while an agent's session
lookup has no link-building rule and its runtime context has no session URL.
Set the bare HTTPS origin, with no path, query, or credentials. If the Control UI
uses a path prefix, configure `gateway.controlUi.basePath` separately.

For an existing server missing only this setting:

```bash
openclaw config set gateway.publicOrigin https://team.example.com --expect-current-absent
```

This conditional write refuses to overwrite an existing value. With live config
reload enabled, the public origin applies without a Gateway restart. When the
allowlist is inherited, browsers using the old origin must reconnect from an
accepted origin. An explicit allowlist remains unchanged. Newly
prepared tool contexts receive the link rule; an already-running turn can retain
its earlier context. Set `https://release.example.com` on the second server,
rather than copying the first server's URL.

Existing installations retain their explicit allowlists, including values saved
by earlier setup or Doctor runs. After upgrading to a version with this default,
remove the list with `openclaw config unset gateway.controlUi.allowedOrigins` if
you want it to follow `publicOrigin`; check that no additional UI origin is needed
first. Startup and Doctor leave the inherited default out of saved config.

## 3. Bootstrap administrators and assign roles

Have the administrator sign in through Access once. Their durable Gateway
profile is created, initially with the observer role. From the local maintenance
shell, list profiles and identify the verified person:

```bash
openclaw users list --json
openclaw gateway call users.setRole \
  --params '{"profileId":"<administrator-profile-id>","role":"administrator"}' \
  --json
```

The role change closes that person's active Gateway connections. Reconnect the
browser. The administrator needs both the explicit `identityScopes` grant and
the administrative role ceiling. The local shared owner remains available for
maintenance and cannot be assigned a personal role.

Extend the Access policy to your team. After each member first signs in, assign
their profile the `member` role through the same method. An observer can read
visible sessions but cannot start agent work in this example. Do not temporarily
make the default role administrative to bootstrap someone.

The example deliberately auto-approves UI devices with non-admin scopes, then
limits each person through their role. Omit automatic approval if you want manual
device enrollment. Do not add `operator.admin` to the automatic device grant;
use selected verified identities instead. See [Operator scopes](/gateway/operator-scopes)
for narrower session-only and sandbox-required roles.

For a release Gateway, keeping the observer default and assigning only a few
release operators is useful. Role assignments are local to each Gateway;
admission to the collaboration server does not grant release authority.

## 4. Synchronize people with verified GitHub identities

Keep these responsibilities separate:

| Responsibility               | Configuration or owner                       |
| ---------------------------- | -------------------------------------------- |
| Who can reach the website    | Cloudflare Access and its identity provider  |
| Which person is signed in    | Verified sign-in and the Gateway profile     |
| What that person may do      | Connection scopes and named operator roles   |
| Which account publishes code | System, agent, or personal GitHub connection |

With the GitHub identity provider in Access, OpenClaw queries Access's identity
endpoint, verifies that its email matches the authenticated proxy principal, and
resolves the immutable numeric GitHub account ID to its current login. Names and
avatars can then update through normal sign-in/profile synchronization. Saved
custom profile choices remain governed by the [User model](/concepts/user-model).

This is sign-in-driven synchronization, not a background import of every GitHub
organization member. Profiles and roles are local to each Gateway. The same
verified GitHub account can identify a person on two servers without making
their local profile IDs equal.

### Use an OIDC provider without losing existing profiles

OIDC sign-in can retain an existing profile through its verified email. Before
changing providers or email addresses, link the new verified address to the
existing person from an administrator's maintenance session:

```bash
openclaw users link-email new-address@example.com \
  --to <existing-profile-id> --json
```

Before switching sign-in, also add the new verified address to any
`gateway.auth.identityScopes` grants that person needs. For the administrator
above, the new address needs its own `["operator.admin"]` entry: linking an email
preserves the profile and role but does not copy the old address's scope grant.
Update any Access policy or `trustedProxy.allowUsers` email allowlist as needed.
Keep the old grant during the migration, verify the profile, aliases, role, and
effective permissions after reconnecting with the new address, then retire the
old grant if that identity should no longer have access. Do not merge people by
display name or copy profile databases between live servers.

For verified GitHub credit through OIDC, configure the explicit
`cloudflareAccessOidc` issuer, provider ID, and account-ID claim described in
[Cloudflare OIDC setup](/gateway/cloudflare-access#verified-github-credit-through-oidc).
The provider must verify the linked GitHub account, and Access must forward its
numeric account ID claim. A username or arbitrary OIDC subject is not a verified
GitHub account ID. Conflicts require administrator linking; the claim does not
assign a role or change the account that publishes code.

If admission depends on GitHub organization membership or repository permission,
enforce that in Access or the identity provider. An organization policy for the
GitHub IdP does not automatically cover a separate OIDC IdP. Understand when
eligibility is rechecked and revoke existing Access sessions when removal must
take effect before their normal expiry.

### Configure GitHub access for repository work

Install `gh` for the Gateway service account. In **Settings → Profile → GitHub
connections**, an administrator chooses **For the system** to connect the shared
publication account. An agent can have an administrative override under
**Agents → Tools**. Verify the selected account before publishing.

**My GitHub** is a separate personal connection for explicitly selected
publication. It does not change the shared shell account or establish verified
sign-in identity. Git co-author credit is also separate: it uses verified human
participants and their saved consent preference.

Use the Gateway's **Publish PR** action for its managed publication path.
Managed identity does not rewrite an existing local repository's SSH remote or
Git network credentials. Successful account verification also does not prove
write permission to every repository. See
[GitHub identity for agent tools](/gateway/config-tools/github-identity).

An optional `gateway.controlUi.github.token` serves GitHub lookups and project
discovery. Keep it in a dedicated SecretRef instead of accidentally selecting a
publisher through a process-wide `GH_TOKEN` or `GITHUB_TOKEN`. Read credentials,
publication credentials, and each person's sign-in identity have different jobs.

## 5. Connect chat and remote clients

Follow [Team setup](/start/teams#step-2-connect-the-team-chat) for channel
allowlists, mention requirements, and DM pairing. Website admission does not
configure the bot's channel allowlist. If a channel sender should resolve to an
existing person, use the explicit administrator-attested channel identity links
in [User model](/concepts/user-model); matching display names are insufficient.

Browser cookies do not authenticate CLI, TUI, or node connections. Remote CLI
clients need `gateway.remote.edgeAuth` and their own Access login; see
[Remote access](/gateway/remote#gateway-behind-an-identity-aware-proxy).

Nodes and cloud workers need a route that authenticates every required join,
WebSocket, and transfer request. Prefer the Access service-token setup in
[Cloudflare machine access](/gateway/cloudflare-access#step-4-decide-how-nodes-and-workers-get-in).
A browser working while `openclaw connect` receives HTTP 302 means the machine
request reached Access, not that node pairing succeeded. Keep machine credentials
out of browser links and do not bypass Access for the whole Gateway.

## 6. Give widgets a separate sandbox origin

Inline Canvas widgets and MCP Apps use a separate sandbox listener. Behind HTTPS
ingress, configure a second hostname that reaches that listener instead of
letting the browser try the Gateway's public hostname on port 18790:

```json5
{
  mcp: {
    apps: {
      sandboxOrigin: "https://team-sandbox.example.com",
    },
  },
}
```

Create a separate proxied DNS CNAME for `team-sandbox.example.com` pointing to
`<tunnel-id>.cfargotunnel.com`, then add
`team-sandbox.example.com -> http://localhost:18790` to the tunnel ingress before
its catch-all rule, using the configured sandbox port if different. Adding an
ingress rule alone does not create the DNS record. See Cloudflare's
[tunnel DNS routing](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/routing-to-tunnel/dns/).
Keep this hostname outside the interactive Access application and route it only
to the sandbox listener, never the main Gateway. The sandbox serves the isolated
renderer shell; authenticated widget content travels through the Gateway. Do not
put other authenticated applications on the sandbox origin.

Canvas can start this listener lazily even when MCP Apps are not enabled.
Enable MCP Apps separately only if you need that capability; see
[MCP Apps](/cli/mcp/apps). Test a real widget after setup: a healthy chat page
does not prove its iframe can load.

## 7. Share selected sessions from another Gateway

To show release-server conversations on the collaboration server, configure
[Session Share](/plugins/session-share). On the source, enable the plugin with
an explicit group:

```json5
{
  plugins: {
    entries: {
      "session-share": {
        enabled: true,
        config: { share: { groups: ["Team"] } },
      },
    },
  },
}
```

On the receiver, advertise the reachable node endpoint before creating a join
code. For the Access service-token topology above, use the same HTTPS hostname;
if you operate a separate authenticated machine endpoint, use that URL instead:

```bash
openclaw config set plugins.entries.device-pair.config.publicUrl https://team.example.com
openclaw plugins enable session-share
openclaw devices join-code
```

The join-code command needs this advertised pairing endpoint on a loopback-only
Gateway; `publicOrigin` alone is not its endpoint-discovery setting. The
`device-pair` plugin does not need to be enabled for core join-code creation.
See [Node onboarding](/nodes/node-host).

On the source, run the node under the source Gateway's account, state directory,
and configuration, with exactly the two read-only session commands:

```bash
openclaw connect <join-url> --service \
  --commands openclaw.sessions.list.v1,openclaw.sessions.read.v1
```

Approve the intended device on the receiver and confirm the two-command
allowlist. Move selected source sessions into the **Team** group. Subagents and
incognito sessions remain excluded. Removing the group revokes new reads but
cannot retract text someone already read.

Receiver-side `linkGitHubIdentities: true`, configured for the paired node ID,
can display verified remote GitHub account IDs as matching local profiles.
This is attribution, not a role or ownership grant. The view stays read-only;
it does not authorize continuing the source session or executing commands there.
An ordinary source session URL still points to that source's own `publicOrigin`
and requires source access.

## 8. Verify the complete flow

Use both host checks and two real user accounts:

1. Run `openclaw config validate --json`, `openclaw gateway status --deep`, and
   `openclaw security audit` as the service owner. Resolve unintended exposure.
2. Confirm that an unauthenticated public request meets Access, then sign in and
   reach a connected Control UI. An Access redirect alone does not prove Gateway
   health.
3. Confirm distinct profiles for two people, administrator/member behavior, and
   observer restrictions. Reconnect after changing a role.
4. Ask the agent for the current session's link and a different visible session's
   link. Open both and check the host and destination. A missing link rule points
   to `publicOrigin`, not `allowedOrigins`.
5. Exercise one model turn, the intended channel reply, a widget if enabled, and
   one node connection if used. Check the selected GitHub account and actual
   repository permissions before a requested publication.
6. If sharing sessions, read a selected source conversation from the receiver,
   then remove a disposable shared session from the source group and verify that
   a fresh receiver read is denied.

## Keep operations recoverable

Use one lifecycle owner per installation. For a normal managed installation,
use `openclaw update` and the native Gateway service commands. If an external
deployment system owns the service, use that owner instead; do not race it with
a second updater, a direct restart, or an in-place source build. Coordinate an
interruption with the team and verify the serving version after activation.
See [Updating](/install/updating) and [Restart recovery](/gateway/restart-recovery).

A collaboration server and a release server can deliberately follow different
update schedules. Make each policy explicit; copying configuration should not
silently enable automatic deployments on the other server. Keep visual
environment labels distinct through `gateway.controlUi.environment`.

Create and verify a backup before substantial updates:

```bash
openclaw backup create --verify
openclaw backup restore <archive.tar.gz> --target <fresh-restore-directory>
```

The restore command stages recovery data; activating it is a separate offline
operation. Keep credentials protected and an off-host copy. Use the native
backup owner's SQLite snapshots rather than copying live database/WAL files.
Do not roll a live server back by overwriting its current databases with an old
snapshot. See [Backups](/install/backups).

Budget persistent disk and temporary space for dependencies, builds, SQLite
snapshot verification, and backups. A large free root disk does not help a
small `/tmp` quota. Configure needed temporary space in the actual service
environment, not only an SSH shell. On Btrfs, inspect metadata allocation and
retained snapshots as well as `df`: snapshots can pin space after files are
deleted. Retire only known disposable data and completed recovery points.

Monitor process restarts, readiness, channel connectivity, storage, and real
session/model failures. Keep incident alerts outside the Gateway that might be
down. A green HTTP root, a quiet bot, or a successful Access login is not enough
to establish that the service can complete work.

## Troubleshooting

| Symptom                                                       | Check                                                                                                            |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Browser works; agent cannot provide session links             | Set this server's `gateway.publicOrigin`; prepare a new turn after reload.                                       |
| Access succeeds but Gateway rejects the connection            | Check loopback trust, forwarded client addresses, required identity headers, and `allowedOrigins`.               |
| Administrator signs in as an observer                         | Assign the real profile's administrative role and grant the verified identity `operator.admin`, then reconnect.  |
| OIDC migration creates another person                         | Verify the sign-in email and explicitly link its alias to the existing profile.                                  |
| GitHub login looks right but publication uses another account | Check the system/agent/personal publication selection and repository Git authentication separately.              |
| Chat works but widgets fail                                   | Check the distinct sandbox origin, tunnel port, and absence of an interactive Access challenge on that hostname. |
| Node join receives HTTP 302                                   | Supply machine Access authentication on every required route.                                                    |
| Shared sessions are missing or names do not link              | Check source group, node account/state, two-command allowlist, receiver role, and verified numeric GitHub IDs.   |
| Update fails despite free disk                                | Check service temporary-space quota, filesystem metadata, and retained snapshots before retrying.                |
