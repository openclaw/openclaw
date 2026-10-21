---
summary: "tools.github: the shared managed GitHub CLI identity, its refresh, and its execution boundaries"
read_when:
  - Giving agents a shared managed `gh` identity instead of native credentials
  - Checking which execution paths receive the launch-bound credential
  - Setting the Git author for agent commits
title: "Configuration — GitHub identity for agent tools"
---

`tools.github` selects the shared managed GitHub CLI identity used by agent execution, and defines which execution paths receive its credential.

## Session GitHub App reader

A configured `tools.github` (or complete agent override) with
`kind: "app-installation"` selects a GitHub App installation for explicitly
admitted session reads. The `app` object specifies `appId`, `installationId`,
`accountId`, exact `repositories` (`id` and `fullName`), `permissions`,
`privateKey` (a SecretRef or resolved signing key), and `keyVersion`.
The existing managed `profileId` identifies the selection.

This reader verifies the configured issuer, App, installation, permissions, bot,
and exact repository set before returning a short-lived token. The request owns
revocation and must finish cleanup before returning private content. Existing
publication, background, and shell execution paths do not acquire App tokens.
Select a native or OAuth identity to run agent tools; App selections support
foreground session reads only. OAuth and native GitHub selections retain their
existing behavior.

An individual repository read can select one configured repository by its full
name. Admission and the installation token cover only that repository, even
when the App configuration lists several. Changes to the complete configured
App selection still invalidate the pending read. App signing-key SecretRefs
from the system and every agent are excluded from agent execution, including
when the executing agent selects OAuth or native credentials instead.

In Factory GitHub mode, session reads additionally require the current person's
verified account on the configured Enterprise host. A one-use, short-lived proof
binds that account, profile, session lifetime, and item digest to the existing
Factory repository-admission broker. Only an authenticated direct-local system
administrator connection can redeem it. A request field cannot supply the
person's identity, and admission never falls back to a human or native token.

## `tools.github`

GitHub CLI identity is native by default. When `tools.github` is omitted, local agent tools, the Codex harness, and Agent Settings follow normal `gh` resolution: `GH_TOKEN` or `GITHUB_TOKEN` from the Gateway process takes precedence, followed by the runtime user's `gh` keyring/config. The Git author comes from the selected agent's workspace.

Gateway GitHub reads and Publish PR account options reuse successful `gh auth token --hostname github.com` reads for up to 60 seconds, matching the credential-verification cache. Host `gh auth login`, `logout`, or `switch` changes can therefore take up to 60 seconds to appear on those read surfaces. Concurrent reads share one native lookup. OAuth shutdown, profile replacement or rotation, and disconnect clear the native-token cache. Environment tokens, managed profile credentials, caller permissions, and session access are still checked live; publication obtains its own live native credential. Failed token reads and anonymous-access absence proofs are not cached.

Use **Settings → Profile → GitHub connections** to see **My GitHub** and **System GitHub** together. Administrators explicitly choose **For the system** to configure this shared execution identity; the general connection flow defaults to **For me** for identified users. Per-agent overrides remain an advanced administrative setting under **Agents → Tools**. A personal connection is separate from `tools.github`: it supports explicitly selected Gateway-brokered publication and does not change agent shell credentials, shared defaults, or verified sign-in identity. See [GitHub connections](/concepts/user-model#github-connections).

OpenClaw displays a one-time user code with a **Copy code** button beside it; clicking the code selects it in full for manual copying. Open the fixed `https://github.com/login/device` link, paste the code, and approve `repo`, `workflow`, `read:org`, and `gist`. The latter two are part of GitHub CLI's minimum classic-token contract. The Gateway owns the device code, token exchange, account verification, private managed `gh` profile, and rotating refresh token. Setup and refresh do not return credentials in browser responses or place them in config, logs, command arguments, transcripts, or the model runtime environment. OpenClaw-owned local exec receives an access token only through its private process-launch environment, as described below.

OAuth access tokens expire after about eight hours. The Gateway refreshes them before expiry, verifies the durable GitHub account ID, and atomically replaces the credential inside the same private profile. New local exec launches use the refreshed credential; an already-running local exec keeps its launch token until it exits. Restart a long-running shell after its access token expires. An expired or rejected refresh token is shown as **Reconnect required**. Refresh never blocks Gateway startup.

Managed profiles and personal publication use `github.com` and its public account-verification endpoint. Enterprise repository settings preserve that issuer binding. Enterprise repository reads and shared publication require a native credential bound to the selected Enterprise host; the separate discovery service credential also retains its declared host binding.

**Use a PAT instead** preserves fine-grained personal access token setup as an explicit alternative. The browser places the pasted token in the secret store as a one-use handoff. The Gateway hard-deletes that handoff before validating the supplied credential with GitHub's `/user` endpoint. Both setup paths write an account-owned private `gh` profile without changing the host's global GitHub CLI login or OS keyring, default Git authorship to the account's standard GitHub noreply identity, and store only secret-free OpenClaw config:

```json5
{
  tools: {
    github: {
      profileId: "ghp_0123456789abcdef0123456789abcdef",
      kind: "oauth",
      gitAuthor: { name: "Automation User", email: "automation@example.com" },
    },
  },
  agents: {
    entries: {
      reviewer: {
        tools: {
          github: {
            profileId: "ghp_fedcba9876543210fedcba9876543210",
            gitAuthor: { name: "Review Agent" },
          },
        },
      },
    },
  },
}
```

Omitting `agents.entries.<id>.tools.github` inherits the system identity. An agent object is a complete managed override. Settings shows the effective identity and the selected configuration scope separately, so editing **System** never masquerades as an agent override. If a configured managed profile is missing, tokenless, or corrupt, GitHub status reports `configured_unavailable` rather than reporting the native account. Gateway-brokered publication verifies the selected profile's own credential and pins it for each child operation; a missing profile cannot redirect publication to native authentication. Ordinary agent shell execution continues to use the shared or per-agent selection, with the execution boundaries described below.

Managed identity selects the `gh` CLI/API account and optional Git author/committer metadata. OpenClaw prepares a non-secret overlay containing the private `GH_CONFIG_DIR`, ambient token scrubs, and configured author fields. For local execution, it does not install a credential helper, rewrite SSH remotes, add HTTP authorization headers, or otherwise override an existing repository's Git network credentials. Commands still use the existing `gh` on `PATH`, including any operator-managed protection or caching wrapper.

For OpenClaw-owned `exec` with `host=gateway`, including Pi `exec` and Codex `gateway_exec`, the local launch owner reads and validates the selected profile immediately before each process launch. It pins `GH_HOST` to that profile's host and places the access token only in the matching private child credential family: `GH_TOKEN` for `github.com` and `*.ghe.com`, or `GH_ENTERPRISE_TOKEN` for GitHub Enterprise Server. The other family and both `GITHUB_TOKEN` and `GITHUB_ENTERPRISE_TOKEN` are cleared; `GH_HOST` is a default, not a restriction on explicit CLI host selection. Approval payloads and shared run environments remain non-secret. A missing, tokenless, wrong-host, or insecure profile refuses the local execution before the command starts instead of permitting native-keyring fallback. This also applies to commands that might invoke `gh` indirectly. Reconnect or change the GitHub Identity selection before retrying. A launched command retains its selected credential even if the profile later disappears; the next exec launch reads the profile again.

**Managed Codex execution uses the same host-owned boundary.** When a managed GitHub identity is selected for a run, OpenClaw disables Codex-native shell execution and routes commands through its host-owned execution tools. These tools retain the executing agent's selected profile, caller authority, approval checks, and cancellation lifecycle. A missing or unavailable managed profile refuses execution rather than falling back to a native account; reconnect or change the identity in Settings before retrying. Without a managed selection, native Codex defaults remain unchanged. This routing does not export Gateway credentials to ordinary paired-node execution.

Choosing a different identity or inheritance target selects another profile for new runs. An admitted run keeps its prior profile selection, and already-launched local exec processes keep their launch token until they exit. Retired profile files are cleaned on the next Gateway restart, so changing this setting is not immediate credential revocation.

If cleanup cannot read a directory's identity, it leaves that directory untouched, logs a warning with the path and reason, and continues checking the remaining profiles. Missing directories are skipped without a warning.

Managed profiles provide execution and coordination identity; they are not an OS-user security sandbox. A process with unrestricted host execution under the same OS account can access account-owned files, including managed `gh` profiles. Use an OpenClaw sandbox, a dedicated host, or a dedicated OS user when adversarial isolation is required.

OpenClaw `worker-turn` cloud workers receive the last background-prepared shared identity through their private launch envelope. Binding the identity does not wait for GitHub discovery on the turn path. This binding does not depend on `allowInSandbox` or a role's `sandbox: "required"` policy, so keep people who must not use the shared account off worker profiles. The worker writes the access token to a private per-turn profile in its throwaway state directory. While the repository-bound turn remains authorized, worker heartbeats renew that profile from the same selected account; later exec launches use the renewed token, while running commands keep their launch token. Renewal stops when the caller, session writer, placement, or selected profile loses authority. The profile is removed after the turn’s admitted commands and in-flight credential writes settle; the same OS-user limit described above applies on the worker host. The sealed worker launcher gives each `exec` child the same launch-time credential binding as local exec. GitHub CLI must be installed on the worker host; the bundle includes the launcher, not `gh`. The checkout uses the session-owned branch and an HTTPS `origin` for GitHub repositories; HTTPS Git authentication uses `gh auth git-credential`, with inherited credential helpers cleared. Commits and pushes happen directly on the worker. Reconciliation returns file contents to the Gateway worktree, not commit history. At every turn start, the worker fast-forwards its checkout to the session branch on `origin` when the local branch is behind, bringing in history pushed by an earlier worker; a diverged local branch is left untouched. Paired devices' own GitHub CLI logins are not used for this binding.

OpenClaw sandboxes exclude the Gateway's managed GitHub credentials by default; the [per-agent sandbox opt-in](/gateway/config-tools/github-identity#sandbox-opt-in) enables them for an agent's own Docker or Podman sandbox. Ordinary node-host exec and Codex `remote-exec` placements still do not receive these credentials. The `github_publish` tool remains available for remote-exec sessions: it records a bounded publication request without credentials or repository authority. After the exact workspace result is reconciled and accepted, the Gateway commits remaining changes as the verified effective GitHub user, pushes the authoritative session branch through a one-shot HTTPS credential helper, and creates or reuses a pull request. New PRs are open by default; `draft: true` explicitly creates a draft. Updates preserve the existing PR state.

The default sandbox tool policy also allows `github_publish` in managed Gateway conversations, including their first turn. The tool uses the same Gateway publisher and does not require `allowInSandbox`, a managed GitHub profile mount, or GitHub credentials inside the sandbox. Explicit tool denies and restrictive custom allowlists still apply. Offering the tool permits a publication request, not publication from an unbound workspace or an unavailable GitHub account: the Gateway checks the current workspace, caller, and selected credential when the tool is invoked. Missing or invalid credentials return the existing retry or reconnect guidance without falling back to another account.

Publication may wait until the requesting turn finishes and its workspace is accepted. Its result is appended to the session transcript; this does not start another agent turn. When the authorized task also includes review, CI repair, or landing, the agent must arrange a separate continuation before ending the requesting turn. A draft PR or publication receipt does not complete a landing request.

Use `github_publish` with `action: "inspect_pr"` and `pullRequestUrl` to inspect
an existing PR authored by a currently verified GitHub account linked to the
requesting person. The URL must name a PR on the configured GitHub host. Copied
Files, Commits and Checks links, query strings and comment or review anchors
resolve to the same canonical PR. The Gateway checks numeric account identity, current session access and the selected
shared publisher. A private repository also requires current repository access
for the linked account; shared credentials alone do not grant that access.

Inspection returns the canonical PR URL, author, state, base and head repository
IDs, branches and observed commits. Closed and merged PRs retain their state;
a deleted head repository returns a null head. Later operations must check their
own write eligibility, current authority and head state before making changes.

This action makes no GitHub or workspace writes, creates no publication receipt,
and does not bind or prepare the PR in the conversation. Its result is data,
not authority for another action. The separate `inspect` action below keeps its
existing full-operator and session-publication requirements.

To continue that PR in a local managed sandbox, use `github_publish` with
`action: "prepare_pr"` and `pullRequestUrl`. A separate inspection call is
optional: preparation verifies the current linked author, repository access,
original head and publisher write eligibility again. The request can be made in
one message or established earlier in the conversation before the URL arrives.
An explicitly empty managed workspace can receive the PR without selecting a
project first. Existing managed projects must match the PR's head or base
repository. Ordinary unbound workspaces are not adopted by this action.

Initial preparation requires a clean workspace without dirty, untracked, or
unpublished work. Otherwise it preserves that work and asks you to keep or finish
it separately before continuing. A clean workspace receives exactly the verified
PR head's files, even when the selected project's base is newer. Preparation
keeps the current directory and sandbox scope and records the original PR
association. The sandbox's current branch and HEAD remain intact; the source
files are staged for work on the PR.

The conversation's PR display follows the prepared original PR, even before a
new publication. It reads the PR's current status without implying that a newer
remote head has been imported. A changed or inaccessible association clears the
previous card. Guests can read only their own prepared PR in their own authorized
conversation, using their current verified GitHub identity and repository access.
This does not grant general GitHub browsing or additional write actions. Private
PR metadata and CI details use the same trusted identity as the own-PR check.
Ordinary temporary GitHub failures retain the same association's last verified
status with a warning; a failed own-PR authorization clears it.

Repeating a completed preparation of the same head preserves later edits without
resetting or synchronizing source files. If the remote PR head has advanced,
preparation refuses clearly; updating an already prepared workspace is not yet
supported. The returned review base is the common ancestor of the accepted PR
head and its base, so an older PR head does not make newer base work appear to be
deleted.

An interrupted initial preparation retains the same accepted source for retry.
If recovery returns `headChanged: true`, it completed that original accepted
head while GitHub has since advanced. Preparation makes no GitHub writes
and is not a publication receipt. Source publication for an imported association
remains unavailable; it refuses instead of creating a replacement PR.

After preparation, existing metadata, readiness, fixed re-review and evidence
actions select the original bound PR, including before any new push and when an
older publication exists in the conversation. Read it with `edit` first. Its
result includes `pullRequest` (URL, repository and branch), rather than claiming
that preparation produced a `publication` receipt. For these imported actions,
send the observed `expectedHeadCommit` without `requestId`; receipt-backed actions
still require their publication's `requestId`. Every guest action rechecks the
current linked author and private repository access. Writes also recheck current
head and publisher eligibility; a changed target or authority refuses the action.

Full-write operators can inspect, close or merge the bound original PR through
the same existing actions and head preconditions, without linking the guest's
GitHub identity to their own account. Existing child-session selection and guest
restrictions remain in force. Preparation does not grant merge or close access,
and an administrator joining does not elevate later guest turns.
Keep the updated Gateway when continuing an imported workspace; older versions
do not understand this association.

Use `github_publish` with `action: "edit"` to change the current session's shared
PR title or description without publishing source. Call it without `title`/`body`
to read the current metadata, then send `requestId`, `expectedHeadCommit`, and only
the fields to change, each paired with its observed `expectedTitle`/`expectedBody`.
Keep the attribution, publication marker and footer unchanged in the full body.
Omitted fields stay unchanged. Guests can edit their own session's PR; no child or
arbitrary PR selector is accepted. Edit never synchronizes, stages, commits or
pushes workspace files, and never changes PR lifecycle state. Closed PRs are read-only.
An unsuccessful later source publication does not hide the existing PR from edit.

Stale observed values are rejected. This is not atomic GitHub compare-and-swap:
external edits can race the PATCH. After a lost response, the Gateway rereads the
same PR; already-applied values need no second write. Read with `edit` before
retrying uncertainty. Omitted action or `publish` still publishes workspace source;
its title/body are creation-only and do not edit an existing PR.

Guests can mark their own current session's shared draft ready for review with
`github_publish` and `action: "ready"`. First read its state with `action: "edit"`,
then supply that publication's `requestId` and `expectedHeadCommit`. Readiness
changes the draft state without publishing more source or merging the PR. It
accepts no child or arbitrary PR selector. After an uncertain response, read with
`edit` before retrying; an already-ready PR returns its observed state.

To request another ClawSweeper review of the current session's shared PR, use
`github_publish` with `action: "request_review"`. Read the PR with `edit` first,
then pass its `requestId` and `expectedHeadCommit`. Guests can request this for
their own authorized publication in local or repository workspaces. The Gateway
posts exactly `@clawsweeper re-review`; comment text, review focus, other commands,
and child or arbitrary PR selectors are not accepted.

The result confirms only that the comment was posted and includes its URL.
ClawSweeper decides whether to accept the request and complete the review. Use
`github_read` to inspect feedback. A lost or invalid write response is uncertain:
read existing PR comments before making another request, since the comment may
already exist. The Gateway never retries the comment POST automatically. Closed
or merged PRs reject this operation; publisher credentials remain on the Gateway.

Use `github_publish` with `action: "upload_evidence"` to upload inspected image or
video proof from the current conversation's sandbox workspace to its existing
shared GitHub.com PR. This action is offered only in active sandboxed sessions
that can verify file provenance. Read the PR with `edit`, then supply its
`requestId` and
`expectedHeadCommit`, plus `evidence` containing a workspace-relative `path`, the
inspected lowercase `sha256`, and `sizeBytes`. Inspect and redact the media before
uploading. PNG, JPEG, GIF, WebP, MP4, MOV and WebM files up to 10 MB are supported;
the bytes must match their filename type, digest and size. Absolute paths, remote
URLs, other mounts and arbitrary repository or PR selectors are not accepted.
The Gateway retains the selected publisher credentials and checks the current
creator, role, session, publisher and PR before sending.

An `evidence.status: "uploaded"` result supplies the attachment URL and inspected
byte facts, with `publicAccess: "unverified"`. Use `edit` to include that URL in the
PR body and verify reviewer access afterward; upload acceptance alone does not
establish public accessibility. An `unconfirmed` result can follow an accepted
write whose response was lost or invalid. The Gateway never retries that upload;
reconcile the original attachment before requesting another transfer.
If upload authority changes after the request begins, the denial also warns that
an attachment may already exist.

A person with full operator write access can request landing in the same conversation, including a guest-created sandboxed session. The agent uses `github_publish` with `action: "inspect"` to read the session's completed shared publication and its current GitHub state. After review and required checks, `action: "ready"` marks its draft ready and `action: "merge"` merges it. To close the PR without merging, use `action: "close"` after inspection. All three writes require the inspected `expectedHeadCommit` and, for a publication receipt, its `requestId`; merge also requires an explicit `mergeMethod` (`merge`, `squash`, or `rebase`). GitHub still enforces repository permissions and merge requirements. These operations do not enable auto-merge or delete the branch, workspace, or conversation.

Squash landing uses the current PR title read by the merge action as the commit subject, including for a one-commit PR whose original subject differs. Contributor trailers remain in the commit body. Merge and rebase methods retain GitHub's existing commit-message behavior.

For delegated work, the agent must explicitly select the child's `publishingSessionKey`. An authorized person's managed parent conversation receives these PR actions even when its own workspace is ineligible for publication; publishing from that parent remains unavailable. The Gateway verifies that the publishing session belongs to this conversation and binds the operation to its recorded PR. A changed publication or GitHub head requires another inspection and review. If an action's response is interrupted, inspect the same publication before retrying; already-ready, already-merged, or already-closed requests return their observed state without another write. Closing preserves the branch, workspace, and conversation history; it does not reopen a closed PR. Failed checks or unavailable credentials leave the saved work intact.

Only a current full-write person's tool schema and instructions expose privileged inspection, merging, closing and child selection. Guest turns retain their own publication, current-PR metadata editing and readiness, including after admin participation in the conversation. Each action also rechecks the initiating person's current authority at the Gateway. Admin participation does not elevate the session or later guest requests, and publication never grants merge authority. The Gateway keeps the publisher credentials and executes only the requested operation; the agent remains responsible for review, testing, and sequencing the landing request.

The Gateway prepares the shared identity for worker launch in the background when a session requests it, and refreshes observed sessions after GitHub configuration, credential, or workspace changes. Idle session rows do not trigger credential discovery. Worker turns consume the last prepared result without waiting; removing a workspace binding retires its old fact. Worker launch still validates current identity authority before attaching any credential.

The built-in, Codex, and Copilot tool surfaces offer `github_publish` immediately in managed Gateway conversations, independently of that background credential discovery. `github_identity_status` reports the selected account and setup or reconnection needs; it does not grant publication. Standalone local runs, detached runs, and runs with tools disabled do not acquire these managed publication tools. Harness options cannot replace the host's decision, and tool profiles and Gateway authorization still apply.

Publication stages workspace changes with ordinary Git attribute conversion. It preserves unchanged committed file bytes, including existing CRLF line endings, rather than renormalizing unrelated tracked files.

<a id="workflow-and-ci-changes" />

Session-only write access can publish ordinary source changes from the requester's own sessions through the configured shared account. Membership in another session does not grant that publication authority. Changes to GitHub Actions definitions in `.github/workflows/*.yml` or `.github/workflows/*.yaml` require the original requester's full operator write authority. This includes committed edits, deletions, and renames. If an accepted snapshot changes those definitions, publication preserves the saved work and asks a maintainer to publish it, or asks the requester to restore the definitions before requesting publication again. The check compares exact paths, modes, and blobs (including deleted definitions) with the published branch or original pull request base. Unchanged published definitions remain allowed. An update inherited unchanged from the authenticated target branch is also allowed when the published definition still matches their unambiguous common ancestor. Newly authored changes and conflicting resolutions still require full write authority, even when the result matches the target branch. Repository-only checkpoints cannot prove unambiguous inheritance from a source base that has diverged from the target, or infer a merge from previously copied workflow contents; those ambiguous updates still require a maintainer.

This check covers only workflow definition files. Workflows commonly run code from the pull request branch, such as package scripts, local actions under `.github/actions/`, and repository scripts. When the checkout's `origin` is the upstream repository, publication pushes the session branch into that repository, and its `pull_request` workflows run with repository secrets. If people with session-only access publish, point the checkout's `origin` at a fork owned by the shared account. Publication then pushes to the fork and opens a pull request against the parent repository's default branch, and the shared account no longer needs write access upstream for publication. By default, GitHub withholds repository secrets from `pull_request` workflows triggered by forks. That isolation does not hold when a private repository sends secrets to fork pull requests, or for `pull_request_target` workflows that run pull request code; review those workflows separately. Publication creates open pull requests by default, or drafts when explicitly requested. It never merges, approves, or changes the state of an existing pull request. Same-conversation landing requires the shared account to have merge access to the PR's base repository. Protect that base branch with required reviews and checks, without granting the shared account bypass permission. A publication-only account can remain unable to merge.

Local session-owned worktrees can use the same **Publish PR** action in the Control UI. The Gateway derives the managed worktree, repository, branch, base, and head from current session ownership. It never accepts those authority facts from the browser or model. Publication retries use a durable request ID, an exact commit marker, remote branch observation, and pull-request lookup by head branch so a Gateway restart or lost response does not create duplicate commits, pushes, or pull requests.

During publication, an accepted PR response still completes its owned receipt if the requesting connection closes or publication permission ends. A successful local branch update likewise finishes its matching index transaction while the execution retains workspace ownership. This settlement does not authorize another push or PR creation; unconfirmed outcomes retain their existing recovery or personal-confirmation requirements.

Before creating a publication commit or changing the local branch and index, the Gateway verifies that the accepted commit shares Git history with the authenticated pull request base, and that the published branch is absent or an ancestor of the accepted local head. Recreating a local branch or expiring its reflog does not invalidate shared commit history. A failed lookup is not treated as an absent branch. A rebased, behind, or unrelated branch is rejected with recovery guidance before new local publication changes. Recovery of an already-started request-owned index transaction still runs first. The push is conditional on the exact observed remote head or branch absence, so a concurrent branch change is rejected. The broker never rewrites published history or rewrites local history automatically.

To refresh an existing PR, preserve its published history and apply the intended edits on top of the published head. If rewritten history is intentional, use a new session branch and a replacement PR instead. Do not merge the old published history back merely to make a rebased branch pushable.

A separate request for unchanged content reuses an owned open PR without a new commit when the remote and local heads match, the accepted index and workspace match that tree, and the head already has a publication marker and all currently required contributor trailers. First publication still creates a request-owned marker, including for already-committed work; missing contributor credit also requires a new marker. Repository-only checkpoint publication already rejects unchanged published trees as `no_changes` and extends only its recorded published head. It cannot adopt external changes to that branch; publish the intended checkpoint from a new session branch if the recorded head no longer matches. These paths retain their existing retry and provenance contracts. For title/body-only edits, update the PR text directly rather than requesting workspace publication; reusing a PR does not update its text.

Verification proves which account answered the GitHub API request. Status reports the credential kind, access expiry, refresh availability, OAuth scopes, and Git author while distinguishing missing credentials, unverified transport failures, and GitHub rate limiting without returning `gh` diagnostics. Repository-specific grants remain unknown until an exact repository operation succeeds; `/user` does not prove write access.

Removing an agent override or choosing native credentials deletes the associated local refresh record after the config change. Already-running local processes may retain the old profile and its current access token until they exit, restart, or the token expires, while new runs use the updated identity immediately. This local change does not revoke the authorization at GitHub; revoke it separately from the OAuth application's GitHub settings when required.

Control UI issue and pull request hover previews use the selected agent's effective managed GitHub identity, including an inherited system identity. An unavailable managed identity produces an actionable error rather than switching to another credential. Without a managed selection, previews retain the optional `gateway.controlUi.github.token` service credential, shared `GH_TOKEN`/`GITHUB_TOKEN` environment fallback for `github.com`, and anonymous public access. Set `gateway.controlUi.github.host` to match `gateway.github.host` for Enterprise service access; an omitted credential host means `github.com`. Previews remain public-only, and their caches are scoped to the credential and host. Project discovery continues to use the separate service credential. When this SecretRef is explicit, OpenClaw excludes its exact environment or store name from agent execution. A custom name does not clear unrelated `GH_TOKEN` or `GITHUB_TOKEN` values used by native identity; a ref named `GH_TOKEN` or `GITHUB_TOKEN` excludes that exact variable.

If a preview or detail view reports “GitHub request is no longer active,” open it again to retry. This describes the interrupted request, not a change to your GitHub account; reconnecting GitHub is unnecessary.

## Sandbox opt-in

`agents.entries.<id>.tools.github.allowInSandbox` is an optional boolean that
defaults to `false`. Enable it on an agent's managed identity when that agent
needs GitHub access inside its own Docker or Podman sandbox, for example a
release agent on a Gateway where every human role requires sandboxing:

```json5
{
  agents: {
    entries: {
      release: {
        sandbox: { mode: "all", scope: "agent" },
        tools: {
          github: {
            profileId: "ghp_0123456789abcdef0123456789abcdef",
            allowInSandbox: true,
            gitAuthor: { name: "Release Agent", email: "release@example.com" },
          },
        },
      },
    },
  },
}
```

Use the agent's existing generated `profileId`; the example is a placeholder.
This setting is agent-only and is not accepted under global `tools.github`.
Replacing or reconnecting the agent's managed identity preserves this setting;
removing the agent override clears it.
Omitting it or setting it to `false` keeps the existing sandbox behavior:
`GH_CONFIG_DIR` is absent, and `GH_TOKEN` and `GITHUB_TOKEN` are blanked.

With the opt-in, OpenClaw mounts only that agent's selected managed profile
read-only at `/openclaw/github` through the existing sandbox bind plumbing and
sets `GH_CONFIG_DIR` to that container path. Sandboxed exec receives the same
configured Git author and committer metadata as host exec. The launch owner
validates the profile immediately before each exec launch and forwards its
access token privately in the matching `GH_TOKEN` or `GH_ENTERPRISE_TOKEN`
family described above, with the other family and both `GITHUB_TOKEN` and
`GITHUB_ENTERPRISE_TOKEN` cleared. The selected profile's
`GH_HOST` is preserved through the container launch. A missing,
tokenless, or insecure profile refuses execution; it does not fall back to
another identity. The Gateway continues to own credential refresh, and existing
processes retain their launch token.

Enabling or disabling this setting changes the container's mounts. If its sandbox
is already running, use `openclaw sandbox recreate --agent <id>` before retrying;
OpenClaw preserves the running container and refuses to reuse stale mounts.

The sandbox image must include `gh` for GitHub CLI commands, and GitHub requests
still require network access under the sandbox's existing network policy. OpenClaw does not
install a Git credential helper or change Git network authentication; Git uses
the remotes and credential helpers configured inside the sandbox, as it does
on the host. The profile is read-only, so run credential setup or rotation
through the Gateway instead of `gh auth login` inside the sandbox.

Effective `scope: "shared"` refuses identity injection and logs a warning naming
the agent, because that container can serve other agents. Role-required
sandboxes use their effective per-creator isolation and support the opt-in even
when the configured default scope is `"shared"`. Other sandbox backends reject
provisioning when the opt-in is enabled; they do not copy the managed profile to
a remote environment.

Read-only mounting protects the profile from modification, but sandboxed code
can read and use its credentials. Every opted-in agent produces a WARN finding
in `openclaw security audit`. Enable this only for agents whose sandboxed code
is trusted with that account's GitHub access.
