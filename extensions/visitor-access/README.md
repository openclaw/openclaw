# Visitor Access

Visitor Access is an internal OpenClaw plugin for granting individual people
access to <https://team.openclaw.ai>. It manages one dedicated Cloudflare Access
allow policy containing email addresses or verified GitHub account selectors. Grants expire after 14 days by default;
administrators and designated owners can refresh or revoke them with agent tools.
Ordinary invitations check the Gateway's restricted guest policy before granting
admission and report the person's current Gateway access separately from the
visitor grant's expiry.

The existing GitHub organization policy remains unchanged. Access allow policies
combine with OR semantics, so adding a visitor does not change maintainer access.
This package is private, built from source for the team deployment, and excluded
from the OpenClaw npm release.

## Configure the plugin

Use a Cloudflare API token that can read and write Access policies in the target
account. Enable the plugin in the source-built Gateway configuration:

```json5
{
  plugins: {
    entries: {
      "visitor-access": {
        enabled: true,
        config: {
          accountId: "<CLOUDFLARE_ACCOUNT_ID>",
          appId: "<ACCESS_APPLICATION_ID>",
          apiToken: "<RESOLVED_CLOUDFLARE_API_TOKEN>",
          policyName: "Visitors (openclaw-managed)",
          defaultTtlDays: 14,
          maxVisitors: 50,
        },
      },
    },
  },
}
```

Enabling the plugin or changing its configuration applies through plugin hot reload;
no Gateway restart is required.
Do not retarget `accountId`, `appId`, `policyName`, or the OIDC account-ID mapping while grants exist: the
durable records belong to that policy, and changing targets could leave the old
policy granting access without expiry sweeps. Revoke grants before retargeting.
Call `visitor_list` from an administrator or designated-owner session to check
policy access and the current Gateway role associated with each invited target.
The first invite creates the named policy if it does not exist. GitHub invitations
use the existing `gateway.auth.trustedProxy.cloudflareAccessOidc` provider and
`githubAccountIdClaim` mapping. Configure that verified sign-in mapping first;
the plugin does not create an identity provider or add a separate login flow.
Tools require the running Gateway service; discovery alone never opens a separate
grant manager. Tool calls and expiry sweeps share that service's mutation queue.

| Field            | Required | Default                       | Constraints                             |
| ---------------- | -------- | ----------------------------- | --------------------------------------- |
| `accountId`      | Yes      | —                             | 1–128 letters, digits, `_`, or `-`.     |
| `appId`          | Yes      | —                             | 1–128 letters, digits, `_`, or `-`.     |
| `apiToken`       | Yes      | —                             | Nonempty resolved token string.         |
| `policyName`     | No       | `Visitors (openclaw-managed)` | 1–200 characters; exact policy name.    |
| `defaultTtlDays` | No       | `14`                          | Integer from 0 through 3650, or `null`. |
| `maxVisitors`    | No       | `50`                          | Integer from 1 through 500.             |

Use a secret reference value through your host or deployment's supported secret
resolution path, then pass the resolved string as `apiToken`. This plugin does
not resolve SecretRef objects itself. Do not paste a real token into chat or
commit it to source control. See [Secrets](https://docs.openclaw.ai/gateway/secrets)
for the host's supported credential surfaces.

Setting `defaultTtlDays` to `0` or `null` does not silently create permanent
grants: each invite must then supply positive `days` or explicitly set
`forever: true`.

For people without an assigned Gateway role, the configured `gateway.roles.default`
must provide the restricted guest policy: `sessions.others: "view"`,
`sandbox: "required"`, at least one permitted agent (or `"*"`), and
`scopes: ["operator.sessions.write"]`. The optional `operator.sessions.read`
scope is equivalent for reading; broader operator scopes do not meet this
invitation policy. Set `accessPolicyPlugin: "visitor-access"` on that same role.
This requirement remains in force if the plugin or its manifest is missing,
disabled, broken, or still starting. Staff roles without this binding and the
Gateway owner retain their independent access to repair the configuration.

The role must also declare `modelPolicy`: `{}` follows the
configured source agent's primary and fallback models. Set `sourceAgent` to name
that agent explicitly, `allow` to replace the permitted set, and `deny` for
resolved model or family exclusions such as `provider/restricted-*`. Apply those
exclusions before enabling guest access; an omitted model policy is unrestricted
and does not qualify as a visitor role. Staff roles may omit it.
A missing or unsuitable default refuses the invitation before
writing the grant or adding the email to Cloudflare. Keep existing staff roles
and their assignments when configuring the guest default.

Activate the guest default only after the deployed Gateway's session and tool
routes, required sandboxing, and shared-session read limits have been qualified.
Visitor Access validates the configured role; the Gateway provides those
capabilities. Preserve existing staff assignments and apply the guest
configuration as the final rollout step.

Guest admission is unsupported on Gateway versions that predate this role
binding. Those versions reject `accessPolicyPlugin` and cannot enforce the local
grant lifetime. Keep the binding and restricted Guest role intact when recovering
access. Restoring older code or a stopped database backup does not establish safe
Guest admission or restore authority for unfinished work.

## Invite, inspect, and revoke visitors

| Tool             | Input                                                                        | Result                                                                                      |
| ---------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `visitor_invite` | Exactly one of `github` or `email`; optional `days` or `forever`, and `note` | Adds a grant or refreshes the same target's expiry, and returns copyable invitation text.   |
| `visitor_list`   | `{}`                                                                         | Shows targets, verified GitHub identities, selection IDs, Gateway access, and policy drift. |
| `visitor_revoke` | `profileId`, `grantId`, or `github`/`email`                                  | Removes a person's recorded grants or cancels a selected invitation.                        |

Each tool also returns structured `details`, visible to Code Mode, with the same
information as its text: invite returns `outcome`, either `email` or `githubAccountId`, `grantId`, optional `githubLogin`,
`expiresAt`, `gatewayAccess`, optional `signInUrl`, `noteStored`, and `invitationText`; revoke returns `outcome`, `emails`,
and optional `githubAccountIds` and `githubLogin`; list returns `counts`, `grants`, `unmanaged`, and `omitted`.
Recorded list rows include `grantId` when the invitation has a qualified lifetime,
and `profileId` when its target belongs to a current profile.

Each listed grant's optional `githubLogin` is the selected verified identity from
its current Gateway profile. The directory is read again on every listing,
including identities linked after an invitation. Without a selected verified
account, the field is omitted and the text reports identity as unavailable.
An unlinked target also reports first sign-in as pending. Stored invitation
handles remain invitation metadata and are not another identity source.
When acting on a listed row, carry its `profileId` to revoke that person's grants
or its `grantId` to cancel that invitation; do not substitute the displayed login.

GitHub revocation resolves the login to its immutable account ID, then selects
that account's profile and recorded email or GitHub grants. It never
selects by historical invitation handles or guesses from a public GitHub email.
Before first sign-in, it can still cancel that exact account's invitation.
If the current directory's selected GitHub login conflicts with that account,
revocation refuses instead of choosing a different person after login reuse.
Use `profileId` for a known person or `grantId` to cancel one invitation
without a GitHub lookup. Explicit email needs no profile-directory lookup and
takes precedence when supplied with a GitHub login to `visitor_revoke`.

Use `visitor_revoke` with `profileId` to select the recorded Visitor grants
associated with that person's verified email aliases and GitHub accounts in an initial profile snapshot. Use `grantId` to
cancel only that invitation, including when first sign-in is still pending and
no profile exists. Copy the IDs from `visitor_list` or the invite result; do not
combine either ID with another selector. An absent grant ID is a no-op and never
falls back to another invitation. An unavailable or merged profile ID requires
listing again and selecting the current profile. Independent staff
roles, saved work, and existing PRs remain intact. Unmanaged policy entries still
require an explicit email or GitHub login; `profileId` revocation does not infer ownership
for them. GitHub revocation also removes the specifically requested account from
the managed policy, including an unmanaged entry for that account.

Revocation by profile ID or GitHub login retains the selected email aliases' original binding
lifetimes and checks current ownership of the selected GitHub account IDs. The profile owner revalidates them at local grant commit and immediately
before each policy request. An email reassignment, including a move away and back, stops
remaining mutations. Already committed expirations remain ended if later cleanup
fails. An in-flight request may already have been accepted by Cloudflare; the
existing cleanup path reconciles ended invitations without restoring them.
This operation requires a Gateway with profile identity preparation support.

An active renewal retains its grant ID. Expiry or revocation ends that lifetime;
a new invitation gets a different ID, so canceling an old invitation cannot
remove a later replacement or revive previously accepted queued work.

For example, invite a visitor for seven days:

```json
{ "github": "octocat", "days": 7 }
```

Invite results identify the target, grant expiry, Gateway access, and login
URL when one is configured. A repeat invite for the same email or GitHub account refreshes its expiry rather than creating
a second grant, and checks the current role again even when the target is already
in the Access policy.
Renewal before expiry preserves the grant attached to accepted shared GitHub
publication requests. After expiry or revocation, a new invitation cannot revive
those old requests, even if the person later receives a staff role. Request
publication again with current access after checking any recorded or unconfirmed
GitHub result; saved work and existing pull requests are retained.
Permanent access requires `forever: true`. Invites beyond `maxVisitors` are
refused; revoke an existing visitor or deliberately raise the configured cap.

Visitors sign in at the Gateway's configured `gateway.publicOrigin`, under
`gateway.controlUi.basePath` when set (for Team, <https://team.openclaw.ai>), through Team's
existing login. Invite either the email that login verifies or the GitHub account
verified through the configured OIDC mapping. The address is a sign-in
location, not a magic link: sharing it does not grant access and the plugin does
not send invitation email or replace the identity provider.

The Gateway owns profile identity and role assignment. Invitation and listing
resolve the target through its existing profile directory, including linked
emails and verified GitHub account IDs. Existing assigned roles are preserved and reported explicitly; inviting
a maintainer does not demote them or describe their access as restricted. An
invitation for an email without a profile reports first sign-in as pending.
An existing verified identity linked during sign-in keeps its assigned role;
use `visitor_list` afterward to inspect the resulting access.

When `github` is supplied, the plugin resolves the login to GitHub's immutable
numeric account ID. Lookups use the Gateway's configured GitHub API credential
(`gateway.controlUi.github.token`, or `GH_TOKEN`/`GITHUB_TOKEN`). Rate-limit errors
report the retry/reset time and suggest configuring the credential when absent. Public email is neither required nor used, and a login rename
does not change the grant's target. Cloudflare must verify that account's ID under
the configured provider and claim. A known profile retains its current
role; an unknown account reports first sign-in as pending. The stored login is a
display label, not an identity binding or GitHub authorship credit.

## Invitation note and text

Pass an optional `note` to `visitor_invite`: free text of at most 1000 characters
from the inviter to the visitor, for example a session link to start from. A
session link goes only in this note; the plugin does not share sessions itself.
A supplied note replaces the stored one; renewal without `note` keeps it. The
result confirms whether a note is stored but does not echo it separately.

After a successful invite or renewal, `invitationText` (also at the end of the
text result) is short plain text for the inviter to hand to the visitor. It
names the inviter when their Gateway profile has a display name, the sign-in
address, the email or GitHub account to sign in with, the expiry in UTC, and the
stored note. It contains no grant IDs, tokens, or other credentials:

```text
Josh invited you to OpenClaw.
Sign in at https://team.openclaw.ai with your GitHub account @octocat.
Your access expires on 2026-11-07 12:00 UTC.

Note from Josh:
Start in https://team.openclaw.ai/chat/roboclaw/welcome
```

The sign-in address comes from `gateway.publicOrigin` plus
`gateway.controlUi.basePath`, like other external Control UI links. When no
public origin is configured or the Control UI is disabled, `signInUrl` is
omitted, the text result names the missing setting, and the invitation text asks
the visitor to get the OpenClaw sign-in address from the inviter.

## Onboarding record

Each new invitation records onboarding metadata with its grant: the inviter's
Gateway profile (`invitedBy`, with a display label when available), an optional
inviter note of at most 1000 characters stored as given, and welcome-session
progress (`onboarding`) that starts as `pending`. The inviter comes only from the
host's trusted requester context, never from tool input; when no human profile
resolves, it stays unset.

Renewal of an active grant keeps the recorded inviter, note, and onboarding
progress unless new values are supplied, and never resets progress to
`pending`. A new invitation after the previous grant expired or was revoked
gets a new grant ID and starts onboarding at `pending` again; the recorded
inviter and note carry over unless replaced. Grants recorded before this
metadata existed keep working without it.

Welcome-session setup inside this plugin uses two service methods:

- `findActiveInvitation(grantId)` returns a snapshot of the current grant with
  that ID, or `undefined` when it expired, was revoked, or was replaced.
- `compareAndSetOnboarding({ grantId, expected, next })` replaces the onboarding
  progress of that still-active grant only when the recorded progress matches
  `expected` by `state` and `updatedAt` (`null` matches a grant without
  progress). It runs on the same queue as invite, revoke, and sweep, so of
  concurrent callers holding one snapshot exactly one applies; the others receive
  `conflict` with the current progress. Expired, revoked, or replaced grants
  return `inactive`; expiry during a write rejects it. Errors longer than 500 characters are truncated.
  `updatedAt` advances monotonically, including a `pending` → `pending` reservation
  in the same millisecond. Reserve a stable session key before creating it; retry
  setup against that same key instead of allocating another session. This API
  serializes the active Gateway service, not independent processes. Session
  creation and restart recovery remain the welcome-setup owner's responsibility.

## Welcome session

The guest Control UI calls the Gateway method `visitor-access.welcome.ensure`
with `{}` on load. It requires `operator.sessions.write` and a signed-in
profile, so the restricted guest role can call it. Nothing the caller sends
selects the invitation: the plugin uses the visitor grant the Gateway admitted
for that connection (its `gatewayAccessGrant` reference). Staff, the Gateway
owner, and anyone else without an admitted visitor grant get
`{ status: "not_applicable" }`.

| Response                                            | Meaning                                                                           |
| --------------------------------------------------- | --------------------------------------------------------------------------------- |
| `{ status: "not_applicable" }`                      | The caller has no active visitor invitation.                                      |
| `{ status: "pending", retryAfterMs }`               | Another call is setting up this invitation's welcome session; call again.         |
| `{ status: "ready", sessionKey, agentId, created }` | The welcome session exists; `created` is true only for the call that finished it. |
| `{ status: "failed", retryable: true, message }`    | Setup failed; calling again resumes it. The message is short and has no secrets.  |

The first call reserves a session key in the grant's onboarding record, then
creates the session as the guest, so the guest owns it and the guest role's
agent, sandbox, and session limits apply. The session uses the configured
default agent when the guest role permits it, otherwise the role's first
permitted agent, and is titled "Welcome, <display name>" ("Welcome" without a
display name). The plugin then adds one agent-written message without running
the model and records the onboarding as `ready`. Any number of calls, tabs,
retries, reloads, or Gateway restarts yield at most one welcome session per
grant: a retry after a failure or crash reuses the reserved key, an existing
session is adopted, and the message is written with a stable idempotency key,
so it is never repeated.

The welcome message greets the guest, names the inviter, includes the stored
note, and gives the access expiry in UTC. It lists what the guest can do from
the current guest role: which agents they can start sessions with, whether work
runs in a required sandbox, and whether they can read other people's sessions.
The inviter appears as a mention, so the session shows up in the inviter's
**Involving me** list and Inbox with the guest named as the sender. Grants
recorded without an inviter get a welcome without a mention. Chat input
normalization applies to the message text, as it does to a typed message.

Renewing an active grant keeps the `ready` record and the session. Expiry or
revocation leaves the session and its transcript in place; the guest simply
loses access. A new invitation after that gets a new grant, so the guest's next
sign-in creates a new welcome session; the earlier one remains. If the guest
deletes their welcome session, later calls still report the recorded session
key.

## Expiry and drift

Email grants retain their lowercased email keys in the Gateway's durable keyed store.
GitHub grants use `github:<accountId>` keys in that same store.
The Gateway requires a current grant for the plugin-managed default visitor role,
using the person's recorded email aliases or verified GitHub account IDs. Known non-default staff roles and
the Gateway owner remain independent of visitor grants. The store has a fixed
cap of 500 records and does not automatically expire them: a record must remain
until policy cleanup succeeds.
Each uninterrupted grant has an internal UUID. Startup assigns one to active
legacy grants before admitting visitors; expired grants do not acquire new
authority. The UUID remains with continuously renewed access and changes after
expiry or revocation. It is not a login credential.

Records from older versions need confirmed Cloudflare policy membership before
they can admit a guest. Startup and the existing hourly sweep perform that check;
missing membership or a failed read leaves the record non-authorizing. A later
sweep or an explicit invite can qualify it. Once qualified, a grant keeps its
recorded deadline across restart even while Cloudflare is unavailable.

If an older Visitor writer renews a row without its grant ID, this version must
confirm policy membership and assign a new ID again. Requalification preserves
the recorded metadata and deadline; it does not revive an ended grant capture.

An invite activates or extends its grant only after Cloudflare confirms the target
is in the policy. Until then, an existing grant keeps its previous deadline. A
new target receives an already-expired cleanup record before the provider write;
that record cannot grant Gateway access, including after restart. If the provider
rejects the write or its response is lost, the record remains so a sweep can clean
up any admission Cloudflare may have accepted. `visitor_list` reads the policy
again to report that drift. An explicit revoke records immediate expiry before
contacting Cloudflare, so a later sweep retries cleanup after a failed or lost
response. Once policy access is removed, the record is deleted. Re-invite to retry
an unsuccessful invite, or revoke to clean up its record. Failure to read or
qualify Gateway access refuses an invitation before writing a cleanup record or
renewing its grant.

Access ends at the recorded deadline, independently of Cloudflare availability.
An explicit revoke ends it before attempting policy removal. Connections and
work that depend on that grant lose their authority; unrelated staff work keeps
its own authority, including work in a visitor-created session. Saved workspace
changes, sessions, attribution, and existing PRs are retained. Renewing an active
grant extends its lifetime; renewing after it ends requires fresh admission and
does not revive canceled work.

The plugin also removes expired targets from the named Cloudflare Access policy
in the background after loading grants on Gateway startup, and hourly. Provider
cleanup does not delay Gateway readiness. It is best effort and retries while
its durable record remains. A failed cleanup or a still-valid Access login does
not restore Gateway access after the grant ends. This plugin does not separately
revoke Cloudflare login sessions or change independent staff admission policies.

Both list and sweep compare policy targets with recorded grants. Targets added
manually in the Cloudflare dashboard are reported as **unmanaged** and are never
automatically deleted. Remove them with an explicit `visitor_revoke`. Recorded
grants missing from the policy are reported as drift; invite again to restore
access or revoke to remove the stale record.

The listed expiry belongs to the visitor grant. It does not establish when an
existing Access session ends or remove access supplied by a separate maintainer
policy. Listing reports policy membership and Gateway role separately, including
expired grants still awaiting cleanup.

Each Cloudflare mutation reads the policy again before writing its full target
include list. No include list is cached across calls. Keep one Gateway responsible
for this policy and avoid concurrent dashboard edits: a full-list update cannot
merge an external edit made between that read and write.

## Trust model and boundaries

Only administrators and explicitly designated owners can invite, renew, list,
or revoke visitors. Each tool requires the host's owner authorization and checks
its live invocation authority after asynchronous work and before grant or provider
effects. Grant writes carry the same manager assertion through SQLite transaction
and commit admission. A queued renewal refused before commit preserves the previous
expiry. Hosts without this state capability refuse invite and revoke with an update
instruction. Making a tool visible through a sandbox override does not authorize its
use. The plugin consumes Gateway profile and role facts and does not create,
assign, or demote roles.

The plugin only manages the policy whose name exactly matches `policyName`. It
does not modify or reorder any other policy, including the maintainer organization
policy. A matching policy whose decision is not `allow` causes a clear refusal.
Cloudflare requests use app-scoped policy endpoints only: no identity-provider
calls and no application mutations. Tokens are never logged or echoed, and fetch
failures use generic diagnostics.
Non-email include rules, nonempty require/exclude rules, or duplicate matching
policy names also require operator inspection before the plugin will write.

Identity-provider management, self-service signup queues, invitation email
delivery, and deep SecretRef support are deliberately outside this plugin's
scope. A maintainer approves each invitation through a trusted session.
