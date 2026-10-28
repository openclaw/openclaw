---
summary: "Connect GitLab accounts for user publication and managed agent operations"
read_when:
  - Configuring GitLab publication
  - Understanding GitLab publication identity and recovery
---

# GitLab connections and publication

GitLab follows the GitHub connection model: **My GitLab** belongs to the signed-in
user, **System GitLab** is an administrator-configured default, and an agent can
have an explicit override. The publication controls identify the selected account.
Credentials stay on the Gateway. Another participant's user connection cannot
authorize publication for you. A missing, expired or disconnected selected
connection does not fall back to a shared account or an ambient CLI token.

## Configure the Gateway

Each deployment currently configures one GitLab issuer and OAuth application. The connection form shows that server in an editable URL field before authorization. Enter the HTTPS server origin, without a repository path. A different server requires administrator OAuth application setup before connecting; entering a URL does not register an application or change the deployment configuration. GitLab.com or another self-hosted HTTPS instance can be configured here; simultaneous connections to multiple GitLab instances are not supported. This setting is separate from choosing GitHub or GitLab as the repository provider.

Register a non-confidential GitLab OAuth application supporting authorization code
with PKCE. Enable `api` and `write_repository`, and register an exact HTTPS
redirect URI under your control. Configure its public application ID, issuer and
an optional project restriction:

```json5
{
  gateway: {
    gitlab: {
      issuer: "https://gitlab.example.com",
      clientId: "YOUR_PUBLIC_APPLICATION_ID",
      redirectUri: "https://gateway.example.com/oauth/gitlab/callback",
      // Optional: restrict publication to these numeric project IDs.
      // Omit to use the connected user's normal GitLab project access.
      projects: [17],
    },
  },
}
```

Use the Gateway's `/oauth/gitlab/callback` path (prefixed by the Control UI base
path when configured). In **Settings → Profile → Git connections → Add provider**,
choose **GitLab** and authorize in GitLab. The callback returns to Profile and
completes the connection through the authenticated Gateway automatically. The
code and state are removed from the browser URL before ordinary routing starts;
tokens and the PKCE verifier stay server-side. The pending request is bound to
the initiating user and can be completed once. Use **Manage connections** to
choose **For me** or, with administrator access, **For the system**. Use **Verify**
to check the selected account. Agent overrides are managed in the agent's Tools
settings. Managed setup is bound to its administrator and exact target; changing
that target or losing administrator access prevents activation. Reconnect when
refresh cannot safely continue. If the completion result is uncertain, verify
the selected connection before starting another authorization.

## Publish from a session

The bundled `gitlab_publish` tool publishes as the requesting person's connected
**My GitLab** account. It never selects System GitLab, an agent override or another
participant's connection. A publication call yields the current turn, runs under
the host's retained requester authority, and resumes the same conversation with
the result. A started handoff is not a completed merge request.

For a clean local checkout not yet owned by the conversation, pass `workspacePath`.
The native workspace owner creates an isolated managed worktree and preserves the
original files. Existing managed sessions use their current worktree. Publication
currently requires a local managed workspace; cloud repository workspaces are not
supported by the GitLab publication transport.

The resulting worktree must have a canonical
HTTPS `origin` on the configured issuer, ending in `.git`. The repository must
resolve to the exact canonical project using the selected account's access. The
repository remote selects the provider; changing a branch does not change the
provider or destination project.

Use `baseBranch` for the repository workflow's selected target (for example,
`develop`); omitting it uses the GitLab project's default branch. The selected
remote parent must be an ancestor of the accepted local source. Local task commits
and workspace edits are published as one commit with the connected user's verified
credit, preserving the remote publishing branch's history. A moved remote branch
requires reconciliation rather than force-pushing.

For an explicitly requested initial empty draft MR, use `bootstrapDraft: true`
and `draft: true`. This permits one empty commit only on a new remote publishing
branch with an unchanged remote base tree. Ordinary no-change publication remains
an error. Use `status` with the returned `requestId` after uncertainty. If recovery
requires confirmation, send `requestId` and the exact `requestDigest`, `generation`
and `account` from its `confirmation`; do not create a replacement request.

Publication records the selected publisher, creates the Git commit with that
account's verified GitLab commit identity, and checks the remote branch SHA. An
existing merge request retains its original author; the current publisher is
reported separately. Accepted requests retain their identity and idempotency key.
After an interrupted or uncertain remote operation, recover that request before
starting a replacement. Disconnecting does not erase completed publication
status or transfer accepted requests to another user. A managed publication also
pins its System or agent source, profile and account generation. Replacing a
selection cannot transfer recovery to a new profile, even for the same account.
An authorized collaborator can observe and recover a shared request in the same
session; its original requester and publisher remain recorded. An unresolved
request blocks a competing publication on that exact session workspace and branch,
including when another account is selected. Other users' private publication
receipts are not exposed by shared discovery.

## Issue skills and other GitLab operations

My GitLab authorizes publication and requester-bound issue/comment operations.
The bundled GitLab plugin provides `gitlab_issues` for issue discovery, metadata,
state changes, notes and threaded issue/MR discussions. Gateway requests bind
the admitted requesting person, their current grant, issuer and project policy.
Missing, ambiguous or revoked authority fails closed. The token stays inside
Gateway HTTP calls and is never supplied to the agent's shell. Requester skills
must use that tool and must not fall back to CLI credentials.

Explicitly selected System/agent CLI operations remain separate. The Gateway verifies and refreshes that
managed account before launch. The selected token is loaded at the child-process
boundary and is excluded from the supervising environment and approval data.
An unavailable selected profile fails closed. Skills must verify the actual actor
and explicit repository before acting; they must stop when a requested account
is unavailable.

Like native GitHub CLI integration, an authorized shell has the selected account's
CLI authority. The shell is not an issuer-confined API boundary, and the optional
publication project restriction does not constrain arbitrary CLI commands. Shared
sandboxes cannot receive managed profiles. A private agent/session sandbox needs
an explicit `allowInSandbox` opt-in and receives the selected profile read-only.
Gateway profiles and tokens are not forwarded to a remote node.

This feature does not add cross-repository issue orchestration. An unconfigured
shell retains ordinary CLI behavior; connecting My GitLab does not silently
configure that shell or replace another provider's credentials.
