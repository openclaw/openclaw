# Visitor Access

Visitor Access is an internal OpenClaw plugin for granting individual people
access to <https://team.openclaw.ai>. It manages one dedicated Cloudflare Access
allow policy containing email addresses. Grants expire after 14 days by default;
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

Restart the Gateway after enabling the plugin or changing its configuration.
Do not retarget `accountId`, `appId`, or `policyName` while grants exist: the
durable records belong to that policy, and changing targets could leave the old
policy granting access without expiry sweeps. Revoke grants before retargeting.
Call `visitor_list` from an administrator or designated-owner session to check
policy access and the current Gateway role associated with each invited email.
The first invite creates the named policy if it does not exist.
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

| Tool             | Input                                                 | Result                                                                                     |
| ---------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `visitor_invite` | `github` and/or `email`; optional `days` or `forever` | Adds a grant or refreshes an existing email's expiry.                                      |
| `visitor_list`   | `{}`                                                  | Shows grant emails, GitHub labels, dates, current Gateway access, and policy/record drift. |
| `visitor_revoke` | `github` and/or `email`                               | Removes the matching visitor; an unknown email is a clean no-op.                           |

For example, invite a visitor for seven days:

```json
{ "github": "octocat", "email": "visitor@example.com", "days": 7 }
```

Invite results identify the visitor, email, grant expiry, Gateway access, and login
URL. A repeat invite for the same email refreshes its expiry rather than creating
a second grant, and checks the current role again even when the email is already
in the Access policy.
Renewal before expiry preserves the grant attached to accepted shared GitHub
publication requests. After expiry or revocation, a new invitation cannot revive
those old requests, even if the person later receives a staff role. Request
publication again with current access after checking any recorded or unconfirmed
GitHub result; saved work and existing pull requests are retained.
Permanent access requires `forever: true`. Invites beyond `maxVisitors` are
refused; revoke an existing visitor or deliberately raise the configured cap.

Visitors sign in at the normal <https://team.openclaw.ai> address through Team's
existing login. Invite the email that login verifies. The address is a sign-in
location, not a magic link: sharing it does not grant access and the plugin does
not send invitation email or replace the identity provider.

The Gateway owns profile identity and role assignment. Invitation and listing
resolve the email through its existing profile directory, including linked
emails. Existing assigned roles are preserved and reported explicitly; inviting
a maintainer does not demote them or describe their access as restricted. An
invitation for an email without a profile reports first sign-in as pending.
An existing verified identity linked during sign-in keeps its assigned role;
use `visitor_list` afterward to inspect the resulting access.

When only `github` is supplied, the plugin looks up that account's public GitHub
email. Many accounts have no public email. In that case, ask the visitor for the
email they use to sign in to Team and pass it explicitly. A public GitHub email
must match that sign-in email to be useful. The plugin cannot discover private
account emails. The optional GitHub login is invitation metadata; it does not
verify or link a Gateway identity or grant GitHub authorship credit.

## Expiry and drift

Grants are recorded by lowercased email in the Gateway's durable keyed store.
The Gateway requires a current grant for the plugin-managed default visitor role,
using the person's canonical email aliases. Known non-default staff roles and
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

An invite activates or extends its grant only after Cloudflare confirms the email
is in the policy. Until then, an existing grant keeps its previous deadline. A
new email receives an already-expired cleanup record before the provider write;
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

The plugin also removes expired emails from the named Cloudflare Access policy
on Gateway startup and hourly. Provider cleanup is best effort and retries while
its durable record remains. A failed cleanup or a still-valid Access login does
not restore Gateway access after the grant ends. This plugin does not separately
revoke Cloudflare login sessions or change independent staff admission policies.

Both list and sweep compare policy emails with recorded grants. Emails added
manually in the Cloudflare dashboard are reported as **unmanaged** and are never
automatically deleted. Remove them with an explicit `visitor_revoke`. Recorded
grants missing from the policy are reported as drift; invite again to restore
access or revoke to remove the stale record.

The listed expiry belongs to the visitor grant. It does not establish when an
existing Access session ends or remove access supplied by a separate maintainer
policy. Listing reports policy membership and Gateway role separately, including
expired grants still awaiting cleanup.

Each Cloudflare mutation reads the policy again before writing its full email
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
