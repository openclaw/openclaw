---
summary: "Run OpenClaw as a multiplayer claw: one shared Gateway for a trusted team, from first setup to an always-on production deployment"
read_when:
  - Setting up OpenClaw for a team or shared workspace
  - Adding teammates to an existing gateway
  - Deciding between a personal claw, one multiplayer claw, or separate gateways
  - Deploying an always-on OpenClaw server for a trusted team
  - Connecting Cloudflare sign-in to Gateway profiles and GitHub identities
  - Operating separate collaboration and release Gateways
title: "Multiplayer"
doc-schema-version: 1
---

OpenClaw runs in one of two shapes. A **personal claw** is one person's assistant on their own machine - see [Personal assistant setup](/start/openclaw). A **multiplayer claw** is one Gateway that a whole team shares: a bot in the workspace chat you already have, shared sessions everyone can open and steer in the Control UI, and roles that bound what each person can do. Both are the same product - multiplayer is configuration, not a separate edition.

This page covers both halves of running a multiplayer claw. [Quick setup](#quick-setup) gets a team working together on any always-on host. [Production deployment](#production-deployment) adds the always-on Linux pieces: Cloudflare Tunnel and Access, individual sign-in, verified GitHub identity, role bootstrap, read-only sharing from another Gateway, and recoverable operations.

## How we build OpenClaw with OpenClaw

We use [team.openclaw.ai](https://team.openclaw.ai) as a multiplayer claw and shared development
workspace for OpenClaw itself. Maintainers and agents work through repository
changes in the same conversations:

1. **Start a repository task.** Choose the OpenClaw project in **New conversation**
   and select **Worktree** for a [managed branch and checkout](/concepts/managed-worktrees).
   Give the agent a concrete change and the checks that demonstrate it works.
2. **Work together.** Teammates with access can open the session, add context,
   and steer the next turn. [Assign an owner](/concepts/multi-user#assigning-an-owner)
   for follow-through; creator and participant attribution remain separate.
3. **Review the work.** Inspect the agent's results and the checkout diff, run
   the relevant tests, and resolve review findings before landing.
4. **Publish and follow CI.** Use **Publish PR** after checking the selected
   [GitHub publication account](/concepts/user-model#github-connections).
   The linked pull request and its CI details stay available in the conversation.

![An OpenClaw development task on our multiplayer claw, with analysis, test results, and a published pull request](https://github.com/user-attachments/assets/b64f4d3a-3988-4f59-ac73-27552b6bdd30)

The screenshot shows a live repository task, cropped to its conversation.
See [Chat and code review](/web/control-ui/chat) for the diff, file, and PR controls.

Building the next version does not replace the running server. We keep
deployment under its own approval and lifecycle owner, with coordinated
activation and verification. See [Keep operations recoverable](#keep-operations-recoverable).

## One trust boundary

A gateway is one trust domain. Everyone who can message a tool-enabled agent shares that agent's delegated tool authority, and everyone with operator access shares one control plane. That is the right model for a team whose members already trust each other - session ownership, presence, and [roles](/gateway/operator-scopes#named-operator-roles) are collaboration guardrails inside the boundary, not isolation between adversaries. Keep untrusted code in sandboxes or remote workers.

If you need to serve mutually untrusted people or organizations, run one gateway per tenant instead, ideally on separate OS users or hosts: [Security trust model](/gateway/security/trust-model).

## Before you begin

- A host for the Gateway that stays on: a small VPS, an office Mac, or any [supported install target](/install).
- OpenClaw installed and onboarded on that host - see [Getting started](/start/getting-started).
- A chat workspace the team already uses (Discord, Google Chat, Mattermost, Microsoft Teams, Slack, Telegram, ...) - see [Channels](/channels).
- A strong latest-generation model. Shared gateways see more varied input than a solo setup, and modern models are substantially more resistant to prompt injection - see [Security](/gateway/security/prompt-injection).
- Optional: teammates' GitHub accounts, if you want verified identity and commit credit.

A [production deployment](#production-deployment) additionally needs:

- A Linux host with persistent storage and a dedicated service account. Use a
  [supported Node runtime](/install/node) and an [OpenClaw installation](/install).
  Plan its storage layout first; see [Optimal setup](#optimal-setup).
- A Cloudflare-managed domain, Zero Trust account, and `cloudflared` on the host.
- An identity provider and an explicit policy for who may sign in.
- Model credentials and, if needed, a bot account for your team chat.
- Administrative SSH access, a private secret store, and a backup destination
  outside the server's failure domain.

## Quick setup

These steps work on any host that stays on. For the full Linux and Cloudflare deployment, continue with [Production deployment](#production-deployment) afterwards.

### Step 1: Give the team access to the Gateway

The Gateway binds to loopback by default. Give teammates access through authenticated ingress instead of a public bind:

- **Tailnet (recommended):** put the host on your tailnet and enable [Tailscale Serve](/gateway/tailscale). With `gateway.auth.allowTailscale`, Control UI sign-in can use each person's Tailscale identity - no shared secret to distribute.
- **Trusted proxy:** front the Gateway with an identity-aware proxy such as Cloudflare Access - see [Trusted proxy auth](/gateway/trusted-proxy-auth).
- **Shared secret:** token or password auth works for small teams, but everyone uses one owner profile instead of per-person identity - see [Authentication](/gateway/authentication).

The identity-backed options are worth the setup: they are what turns "someone did something" into "who did what" in the session UI and commit credit below.

### Step 2: Connect the team chat

Connect the channel your team lives in. Example: a Slack bot, allowed in one team channel, that replies when mentioned:

```json5
{
  channels: {
    slack: {
      enabled: true,
      mode: "socket",
      appToken: { source: "env", provider: "default", id: "SLACK_APP_TOKEN" },
      botToken: { source: "env", provider: "default", id: "SLACK_BOT_TOKEN" },
      groupPolicy: "allowlist",
      channels: {
        "<SLACK_CHANNEL_ID>": { requireMention: true },
      },
    },
  },
}
```

Group chats are a first-class deployment. The defaults are already team-shaped. Group access is allowlisted per room, and replies require a mention. DMs stay on the pairing default: the first time a teammate DMs the bot they get a pairing code. Approve it with `openclaw pairing approve slack <code>`. So the bot participates when addressed and stays quiet otherwise. In a private room whose members you trust, that is all the gating you need. For broad or public rooms, add sender allowlists and `contextVisibility` - see [Groups](/channels/groups).

If the same people should be allowed across several channels, define the list once as an [access group](/channels/access-groups) and reference it from each channel's allowlist.

### Step 3: Sign the team in to the Control UI

With per-person sign-in, each teammate opens the [Control UI](/web/control-ui) through the ingress from step 1. Each one gets a durable Gateway profile: display name, avatar, and per-person appearance preferences. Shared-secret connections use the same owner profile. With Cloudflare Access or Tailscale Serve, GitHub-backed sign-in verifies the account behind the profile - see [User model](/concepts/user-model).

Teammates can also create and import [personal skills](/tools/skills#personal-skills-on-a-shared-gateway) under **Plugins → Skills** without permission to change shared Gateway configuration. Skills stay personal until explicitly shared with the team. A session retains its selected revisions when another teammate joins; changing its assignee does not replace its skills. Your existing workspace skills remain in place, and extra channel identities for one operator do not enable the team-specific guidance.

### Step 4: Work in shared sessions

A conversation that starts in the team channel can continue as a session the whole team can open, steer, and take over. [Multi-user mode](/concepts/multi-user) gives every session three layers of attribution: an immutable creator, an assignable owner, and the history of people who actually prompted. Assign sessions like GitHub issues from the session context menu. Multi-user mode also adds live [presence](/concepts/presence). Presence shows who is viewing and who is typing, with drafts that never reach the model or the transcript.

For coding work, verified GitHub identity pays off at the commit: with **Git co-author credit** enabled, commits from a shared session carry `Co-authored-by` trailers for the people who steered it, and generated pull requests link back to the session so reviewers can read the conversation that produced the diff.

Teammates can add their own provider accounts under **Settings → Profile → Connected accounts**, using the sign-in methods offered by each provider. Their new sessions prefer that account without making it a Gateway-wide default. Collaborators use the session's selected account, and shared same-provider failover can still apply - see [Per-person model accounts](/concepts/multi-user#per-person-model-accounts).

To let teammates read selected sessions from a personal Gateway without controlling that machine, use [Session Share](/plugins/session-share). The source operator chooses session groups and pairs a node that advertises only the two read-only session commands. Shared transcripts appear under that node in the team Control UI; viewing requires permission to view others' sessions, and does not allow continuing the source session.

### Step 5: Bound what each person can do

Named operator roles bind authenticated profiles to a policy: which sessions they can touch, which agents they can use, a maximum set of operator scopes, and whether their new sessions must be sandboxed:

```json5
{
  gateway: {
    roles: {
      default: "guest",
      definitions: {
        maintainer: {
          sessions: { others: "write" },
          agents: ["roboclaw"],
          scopes: ["operator.read", "operator.write", "operator.approvals"],
        },
        guest: {
          sessions: { others: "view" },
          agents: ["roboclaw"],
          scopes: ["operator.sessions.write"],
          sandbox: "required",
        },
      },
    },
  },
}
```

Give guests the session-only `operator.sessions.write` scope, which also permits reading. `operator.read` and `operator.write` are Gateway-wide: they add channel sends, node and computer control, logs, the user directory, and other shared surfaces that a guest does not need. With `sessions.others: "view"`, guests can still read every shared session, including tool output. Keep sensitive work in draft sessions.

Assign roles with the `users.setRole` Gateway method; see [Named operator roles](/gateway/operator-scopes#named-operator-roles) for the full policy surface and [Permission modes](/gateway/permission-modes) for per-session tool posture. To admit and expire individual outside guests, see [Invite guests](#invite-guests).

#### Coding as a guest

A sandbox-required guest can work without an administrator role. With the default
`workspaceAccess: "none"`, file and shell tools use a writable private workspace,
not the shared agent workspace. Managed skill instructions stay read-only.
Child sessions inherit the parent's sandbox requirement, even when the agent's
default sandbox mode is off.

Local container sandboxes have no network by default. If guests need to clone
public repositories or install project-local dependencies, explicitly enable
outbound networking for the coding agent, for example:

```json5
{
  agents: {
    entries: {
      roboclaw: {
        sandbox: {
          workspaceAccess: "none",
          docker: { network: "bridge" },
        },
      },
    },
  },
}
```

Network access does not grant host execution or inject shared credentials. Use a
sandbox image with the required runtimes already installed; the read-only root
filesystem still prevents system package installation. Enabling egress allows
requests to destinations reachable from the container, so use a restricted
container network when that access needs tighter controls. See
[Sandboxing](/gateway/sandboxing#workspace-access) for workspace and network policy.

Guests publish through **Publish PR** from sessions they created. Publication
uses the shared GitHub account and opens a pull request by default. To create a
draft, ask the agent to publish with `draft: true` on `github_publish`. Updating an
existing PR preserves its draft or open state. Publication does not merge the PR. Protect the
base branch with GitHub rules so the shared account cannot
merge or bypass review. If the checkout's `origin` is the upstream repository,
guest branches live in that repository and its pull request workflows receive
repository secrets. Point `origin` at a fork owned by the shared account so
guest pull requests come from the fork, where GitHub withholds secrets from
`pull_request` workflows by default. See
[Workflow and CI changes](/gateway/config-tools/github-identity#workflow-and-ci-changes).

### Verify the quick setup

- Mention the bot in the allowed team channel and confirm it replies there.
- Open the Control UI as two different people: both should see the session, its owner avatar, and each other's presence.
- Run `openclaw security audit` on the host and resolve anything it flags about inbound access or exposure.

## Production deployment

This section connects the pieces of a production multiplayer deployment: a persistent
Gateway, Cloudflare Tunnel and Access, individual sign-in, GitHub identity,
operator roles, and optional read-only sharing from another Gateway. Start with
one server. Add a separate release or staging server when it needs different
credentials, update timing, or operators.

It uses `team.example.com` for collaboration and
`release.example.com` for an optional second Gateway. Replace them with your
own hostnames; each Gateway needs its own configuration and state.

### Optimal setup

A busy multiplayer claw runs many agents, managed worktrees, and SQLite databases on
one host. Its storage layout decides how responsive it stays under that load.

**Keep OpenClaw state off the worktree filesystem.** Put the state directory
(`~/.openclaw` by default, or [`OPENCLAW_STATE_DIR`](/help/environment)) on XFS
or ext4. Put managed worktrees on Btrfs with
[`worktreeRoot`](/concepts/managed-worktrees#choose-where-worktrees-are-stored),
where snapshots make new checkouts nearly instant; XFS reflinks also work. See
[Filesystem acceleration](/concepts/managed-worktrees#filesystem-acceleration).

Btrfs commits are filesystem-wide. While a commit runs, SQLite reads and writes
that update file metadata can wait for it, and worktree snapshot creation and
deletion make commits long. On a busy shared Btrfs volume we have measured
single commits that took minutes and database commits that stalled for seconds.
OpenClaw already creates SQLite stores with
[NOCOW on Btrfs](/reference/database-schemas/integrity-and-recovery#btrfs-and-nocow),
which limits fragmentation but does not remove these waits.

Keep the whole state directory on one filesystem. OpenClaw moves files between
its subdirectories with renames, and a rename cannot cross filesystems.

**Mount with `noatime`.** Under the default `relatime`, a database that is
written continuously gets an access-time update on almost every read. On Btrfs,
each update joins the current transaction and can wait for a running commit;
`lazytime` does not avoid this on Btrfs. OpenClaw does not read access times.
You can switch a mounted filesystem without a restart, then add `noatime` to its
`/etc/fstab` entry:

```bash
sudo mount -o remount,noatime /
```

**Choose disks for the databases.** Mirror the state filesystem (RAID1) when you
can, so one failed drive does not take the databases with it. Drives with
power-loss protection acknowledge cache flushes quickly, which keeps SQLite
fsync latency low.

**Move an existing Btrfs-only host.** Apply `noatime` first; it needs no
downtime. Moving state then needs block-device space outside Btrfs: a new drive
or partition, or space at the end of the device released with
`btrfs filesystem resize`. Stop the Gateway, copy the state directory, mount the
new filesystem at the same path, and bind-mount the worktree directories back
from Btrfs so recorded worktree paths stay valid. If the new filesystem lives in
space released from Btrfs, never grow that Btrfs filesystem again
(`btrfs filesystem resize max`): it would overwrite the new filesystem.

### 1. Install under one service account

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

### 2. Configure the public URL and authenticated ingress

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

#### Set the public URL once

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

### 3. Bootstrap administrators and assign roles

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

#### Invite guests

To admit individual people outside the team for a limited time, use the
[Visitor Access plugin](/plugins/reference/visitor-access), available from a
source checkout. It manages one dedicated Access allow policy, adds each
invited email or verified GitHub account to it, and ends Gateway access when
the grant expires (14 days by default) or is revoked.

Visitor Access requires `gateway.roles.default` to be a restricted guest role:

```json5 validate=false
// Inside gateway.roles
default: "guest",
definitions: {
  guest: {
    sessions: { others: "view" },
    agents: ["assistant"],
    scopes: ["operator.sessions.write"],
    sandbox: "required",
    accessPolicyPlugin: "visitor-access",
    modelPolicy: {},
  },
},
```

Everyone who resolves to the default role needs a current visitor grant. Before
switching the default, assign every staff member an explicit role with
`users.setRole` or `gateway.roles.assignments.byGithubLogin`. An administrator
then asks the agent to call `visitor_invite` with a GitHub login or email and an
optional note, such as a session link to start from. The result includes short
invitation text to hand to the guest: who invited them, the sign-in address from
`gateway.publicOrigin`, the identity to sign in with, the expiry, and the note.

Guests can create sandboxed sessions on the listed agents and publish open or
explicitly requested draft pull requests from their own sessions through the
shared GitHub account. They cannot merge through OpenClaw. Before inviting anyone, review the paths a
required sandbox does not contain, listed under
[Named operator roles](/gateway/operator-scopes#named-operator-roles), and
[Workflow and CI changes](/gateway/config-tools/github-identity#workflow-and-ci-changes)
for publication.

### 4. Synchronize people with verified GitHub identities

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

#### Use an OIDC provider without losing existing profiles

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

#### Configure GitHub access for repository work

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
discovery. For Enterprise, set `gateway.controlUi.github.host` to the selected
`gateway.github.host` so the service credential is used only for that host.
Keep it in a dedicated SecretRef instead of accidentally selecting a
publisher through a process-wide `GH_TOKEN` or `GITHUB_TOKEN`. Read credentials,
publication credentials, and each person's sign-in identity have different jobs.

### 5. Connect chat and remote clients

Follow [Step 2: Connect the team chat](#step-2-connect-the-team-chat) for channel
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

Trusted relay plugins can use [principal-bound remote ingress](/plugins/sdk-gateway-ingress)
for a remote Control UI and MCP calls; [MCP Relay](/plugins/mcp-relay#team-gateways)
uses it to bring a Team Gateway into ChatGPT and Codex. A Team grant belongs to the verified person
who approves it in this Gateway's Control UI, never the shared owner or the
loopback password. The plugin's consent flow should default to **Read + write**
and offer **Full** within that person's current role. Full gives administrators
admin access and does not elevate restricted roles. Both UI and RPC must share
the same live grant; the plugin and relay own expiry and revocation. Ingress
reconnects are tokenless and issue no reusable device token. This SDK capability
does not itself install or configure a relay service.

### 6. Give widgets a separate sandbox origin

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

### 7. Share selected sessions from another Gateway

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

On the receiver, the `gateway.publicOrigin` configured above supplies the join
endpoint when the loopback Gateway has no other advertised route. For the Access
service-token topology above, use that same HTTPS hostname. If you operate a
separate authenticated machine endpoint, set
`plugins.entries.device-pair.config.publicUrl` to its URL instead:

```bash
openclaw plugins enable session-share
openclaw devices join-code
```

Join codes retain existing Tailscale, remote, and bind-derived routes before
falling back to `publicOrigin`. The pairing-specific `publicUrl` override takes
precedence over discovery. The `device-pair` plugin does not need to be enabled
for core join-code creation.
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

### 8. Verify the complete flow

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

For rootless Podman sandboxes, budget one kernel session keyring per running container under the Gateway service user's per-user quota. On a busy host, set `kernel.keys.maxkeys=2000` and `kernel.keys.maxbytes=200000` with `sudo sysctl -w kernel.keys.maxkeys=2000 kernel.keys.maxbytes=200000`, and persist both values in `/etc/sysctl.d/61-openclaw-keyring-quota.conf`. A `create keyring: Disk quota exceeded` error can mean this quota is exhausted even when the filesystem has space; inspect `sysctl kernel.keys.maxkeys kernel.keys.maxbytes` on the container engine host.

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

## When to split things up

- **Separate workspaces or personas** (projects that must not share memory or files): use multiple agents on one gateway - see [Multi-agent routing](/concepts/multi-agent).
- **Mutually untrusted users, customers, or organizations:** separate gateways, ideally separate OS users or hosts - see [Security trust model](/gateway/security/trust-model) and [Security](/gateway/security).

## Related

- [Why OpenClaw: working together](/start/why-openclaw#working-together) - the team collaboration surfaces in one place
- [Multi-user mode](/concepts/multi-user) - ownership, participants, and owner filtering in depth
- [Operator scopes](/gateway/operator-scopes) - connection roles, scopes, and role assignment
- [Groups](/channels/groups) - group behavior, mention gating, and context visibility
- [Security](/gateway/security) - the trust model behind the one-boundary rule
