---
summary: "tools.github: the shared managed GitHub CLI identity, its refresh, and its execution boundaries"
read_when:
  - Giving agents a shared managed `gh` identity instead of native credentials
  - Checking which execution paths receive the launch-bound credential
  - Setting the Git author for agent commits
title: "Configuration — GitHub identity for agent tools"
---

`tools.github` selects the shared managed GitHub CLI identity used by agent execution, and defines which execution paths receive its credential.

## Native execution and repository preparation

Authenticated local Codex native runs use the effective System GitHub account or
explicit agent override through a private run-owned profile. GitHub App settings
do not select another execution account. The selected account remains separate
from the original Factory operator/session proof and verified commit author.
Incognito and standalone execution retain their existing native/managed behavior.

Worker commands use the configured bot's selected credential and Git author when
configured. The signed-in GHE user remains the original intent's authority for
session access, approvals and attribution; that user's credential does not become
the bot's shell token. If no bot author is configured, the existing verified user
author applies. Initial checkout, native commands and credential renewal retain
the same selected bot account, host and private profile.

The private profile and HTTPS Git helper reach native commands through per-run
shell policy, never the shared app-server environment. The existing OAuth owner
refreshes the same account. Cancellation, authority loss, and finalization join
credential delivery and remove the execution profile without revoking the
underlying account authorization. Missing managed credentials refuse execution.

Worker repository checkout and retained checkpoint recovery use the same selected
identity through the canonical read owner and current Factory caller proof.
Prepared checkout reuse does not request an unnecessary credential. Recovery
preserves accepted checkpoints, verifies remote history, and retains failed worker
resources and unresolved edits; it does not push or change the old disk.

Worker preparation preserves validated credential-service failures with their
bounded stage, code, and HTTP status. A broker rejection reports that access was
not established; it does not establish a missing token or prescribe reconnecting.
Factory diagnostics remain subject to the original current authority and exact
one-use proof redemption. Unknown preparation failures retain their cause without
guessing a reconnect remedy. Confirmed unavailable selected credentials still
report the existing reconnect guidance.

Existing personal publication receipts remain readable under their original human
owner. Configuring a bot never redirects an accepted personal write to the bot;
new personal publication and confirmation are refused until the operator reviews
that original outcome. Shared publication still pins its selected account and
rechecks original requester, workspace and execution authority before each effect.
Human approval and verified contributor attribution remain independent of the
bot's authenticated account. Standalone/native fallbacks without a managed
selection and public-only capability hosts remain supported exceptions; they do
not borrow an Enterprise bot token for another host.

## `tools.github`

GitHub CLI identity is native by default. When `tools.github` is omitted, local agent tools, the Codex harness, and Agent Settings follow normal `gh` resolution: `GH_TOKEN` or `GITHUB_TOKEN` from the Gateway process takes precedence, followed by the runtime user's `gh` keyring/config. The Git author comes from the selected agent's workspace.

Gateway GitHub reads and Publish PR account options reuse successful `gh auth token --hostname github.com` reads for up to 60 seconds, matching the credential-verification cache. Host `gh auth login`, `logout`, or `switch` changes can therefore take up to 60 seconds to appear on those read surfaces. Concurrent reads share one native lookup. OAuth shutdown, profile replacement or rotation, and disconnect clear the native-token cache. Environment tokens, managed profile credentials, caller permissions, and session access are still checked live; publication obtains its own live native credential. Failed token reads and anonymous-access absence proofs are not cached.

Publish PR options bound session/requester admission to five seconds, then allow
five seconds for credential verification and options discovery. A cold requester
therefore does not consume the credential read's budget. Timeout ends that read
with a retryable error; it does not retry automatically or request publication.
The original caller, session and requester authority remain current through the
final response. Options discovery is separate from an existing publication's status.

Use **Settings → Profile → GitHub connections** to see **My GitHub** and **System GitHub** together. Administrators explicitly choose **For the system** to configure this shared execution identity; the general connection flow defaults to **For me** for identified users. Per-agent overrides remain an advanced administrative setting under **Agents → Tools**. A personal connection is separate from `tools.github`: it supports explicitly selected Gateway-brokered publication only when no managed system or agent bot is configured. A configured bot owns all GitHub execution, repository preparation, discovery, previews, PR reads and publication. My GitHub does not override it or change verified sign-in identity. After verified GitHub sign-in, the Control UI starts personal GitHub consent when My GitHub is disconnected. Complete the displayed device authorization to supply the personal token; the external sign-in assertion itself is not an API credential. See [GitHub connections](/concepts/user-model#github-connections).

OpenClaw displays a one-time user code with a **Copy code** button beside it; clicking the code selects it in full for manual copying. Open the fixed `https://github.com/login/device` link, paste the code, and approve `repo`, `workflow`, `read:org`, and `gist`. The latter two are part of GitHub CLI's minimum classic-token contract. The Gateway owns the device code, token exchange, account verification, private managed `gh` profile, and rotating refresh token. Setup and refresh do not return credentials in browser responses or place them in config, logs, command arguments, transcripts, or the model runtime environment. OpenClaw-owned local exec receives an access token only through its private process-launch environment, as described below.

OAuth access tokens expire after about eight hours. The Gateway refreshes them before expiry, verifies the durable GitHub account ID, and atomically replaces the credential inside the same private profile. New local exec launches use the refreshed credential; an already-running local exec keeps its launch token until it exits. Restart a long-running shell after its access token expires. An expired or rejected refresh token is shown as **Reconnect required**. Refresh never blocks Gateway startup.

Device OAuth and My GitHub credentials belong to public GitHub. Setup and refresh
verify them at `https://api.github.com/user` and store them under `github.com`,
even when the Gateway's repository host is Enterprise. They cannot publish to
an Enterprise repository. Enterprise repositories retain their explicitly
host-bound native, PAT, or Factory broker credentials; repository configuration
does not change an OAuth token's issuer.

**Use a PAT instead** preserves fine-grained personal access token setup as an explicit alternative. The browser places the pasted token in the secret store as a one-use handoff. The Gateway hard-deletes that handoff before validating the supplied credential with GitHub's `/user` endpoint. Both setup paths write an account-owned private `gh` profile without changing the host's global GitHub CLI login or OS keyring, default Git authorship to the account's canonical GitHub noreply identity, and store only secret-free OpenClaw config:

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

For OpenClaw-owned `exec` with `host=gateway`, including Pi `exec` and Codex `gateway_exec`, the local launch owner reads and validates the selected host's profile immediately before each process launch. It places that access token in `GH_TOKEN` and `GH_ENTERPRISE_TOKEN` only in the private child environment, pins `GH_HOST`, and clears the `GITHUB_*` fallbacks; approval payloads and shared run environments remain non-secret. A missing, tokenless, or insecure profile refuses the local execution before the command starts instead of permitting native-keyring fallback. This also applies to commands that might invoke `gh` indirectly. Reconnect or change the GitHub Identity selection before retrying. A launched command retains its selected credential even if the profile later disappears; the next exec launch reads the profile again. Sandbox command launches forward these existing variables by name. A missing Enterprise profile entry cannot borrow a public GitHub token.

Authenticated local Codex native commands receive their run-owned private profile and HTTPS Git helper. Standalone and incognito native shell execution retain the non-secret selected-profile overlay; use `gateway_exec` when launch-time credential validation is required there. `GH_CONFIG_DIR` is not an OS-user security sandbox.

Choosing a different identity or inheritance target selects another profile for new runs. An admitted run keeps its prior profile selection, and already-launched local exec processes keep their launch token until they exit. Retired profile files are cleaned on the next Gateway restart, so changing this setting is not immediate credential revocation.

Managed profiles provide execution and coordination identity; they are not an OS-user security sandbox. A process with unrestricted host execution under the same OS account can access account-owned files, including managed `gh` profiles. Use an OpenClaw sandbox, a dedicated host, or a dedicated OS user when adversarial isolation is required.

OpenClaw `worker-turn` cloud workers receive the effective shared identity per turn through their private launch envelope. The worker writes the access token to a private per-turn profile in its throwaway state directory. Retained background commands keep their own earlier profile until the owning process cleanup joins them; a later turn receives a separate profile and cannot replace their credentials. The same OS-user limit described above applies on the worker host. The sealed worker launcher gives each `exec` child the same launch-time credential binding as local exec. GitHub CLI must be installed on the worker host; the bundle includes the launcher, not `gh`. The checkout uses the session-owned branch and an HTTPS `origin` for GitHub repositories; HTTPS Git authentication uses `gh auth git-credential`, with inherited credential helpers cleared. Commits and pushes happen directly on the worker. Reconciliation returns file contents to the Gateway worktree, not commit history. At every turn start, the worker fast-forwards its checkout to the session branch on `origin` when the local branch is behind, bringing in history pushed by an earlier worker; a diverged local branch is left untouched. Paired devices' own GitHub CLI logins are not used for this binding.

Approved Codex node `codex.exec-server.stdio.v1` execution receives the same effective system or explicit agent GitHub identity as cloud workers. GitHub App installation settings do not override this selection. A missing configured managed credential refuses the turn instead of using a node login or another account. My GitHub stays available for explicitly selected user publication and never replaces the agent's execution account.

The Gateway reuses the selected account's existing OAuth owner and delivers profile rotation through authenticated worker heartbeats or private Codex node messages. Completed managed-profile writes trigger delivery immediately; a bounded one-minute check also notices native or externally changed credentials. The execution account stays pinned, and an account or selection change closes the old delivery lifetime. Refresh-capable paired nodes are required; update and reconnect older nodes before GitHub-backed execution. Private frames stay outside native Codex JSON-RPC, and restrictive native environment policies retain the admitted profile.

Worker turns prepare their repository identity and GitHub discovery together with
a fresh execution grant. Equivalent selections share those prepared facts;
configured Factory execution that selects another identity keeps separate
publication discovery. Session, repository, branch, caller, and execution
ownership are checked again after preparation and before use.

Verified account facts for managed OAuth credentials can be reused for at most
five minutes from verification, capped by their verified access-token expiry.
Hits do not extend that deadline. Profile changes invalidate those facts, and
new turns still read the selected credential and receive independent grants.
This cache does not hold bearer credentials or turn authority. Credentials
without verified expiry retain the existing one-minute verification window;
native publication and execution credentials are still looked up freshly for
each turn. OAuth refresh remains driven by the credential's expiry.

Turn completion preserves existing process shutdown, write settlement, workspace reconciliation, and resource cleanup. Terminal acknowledgment stops further credential renewal. Private profiles are removed through their owning execution, process, or lease cleanup after retained commands and in-flight writes have settled; the underlying GitHub account authorization is not revoked. A copied bearer token remains governed by GitHub expiry and remote revocation. Configured shared execution may deliberately have more repository access than the initiating user; no OpenClaw role expands the selected token's permissions.

OpenClaw sandboxes exclude the Gateway's managed GitHub credentials by default; the [per-agent sandbox opt-in](/gateway/config-tools/github-identity#sandbox-opt-in) enables them for an agent's own Docker or Podman sandbox. Ordinary node-host exec and Codex `remote-exec` placements still do not receive these credentials. The `github_publish` tool remains available for remote-exec sessions: it records a bounded publication request without credentials or repository authority. After the exact workspace result is reconciled and accepted, the Gateway commits remaining changes as the verified effective GitHub user, pushes the authoritative session branch through a one-shot HTTPS credential helper, and creates or reuses a draft pull request.

Publication may wait until the requesting turn finishes and its workspace is accepted. Its result is appended to the session transcript; this does not start another agent turn. When the authorized task also includes review, CI repair, or landing, the agent must arrange a separate continuation before ending the requesting turn. A draft PR or publication receipt does not complete a landing request.

Gateway-hosted agents check publication availability for ordinary messages and internal continuations, including when a subagent finishes after the requester yields. The check uses the current session workspace and GitHub identity. If publication is unavailable, `github_identity_status` remains available to explain identity setup or reconnection needs, subject to the session's tool policy. Standalone local runs and runs with tools disabled do not expose these managed publication tools.

The built-in, Codex, and Copilot tool surfaces use this same host-prepared availability. Harness options cannot replace the host's decision; tool profiles and Gateway authorization still apply.

Publication stages workspace changes with ordinary Git attribute conversion. It preserves unchanged committed file bytes, including existing CRLF line endings, rather than renormalizing unrelated tracked files.

Session-only write access can publish ordinary source changes from the requester's own sessions through the configured shared account. Membership in another session does not grant that publication authority. Changes to GitHub Actions definitions in `.github/workflows/*.yml` or `.github/workflows/*.yaml` require the original requester's full operator write authority. This includes committed edits, deletions, and renames. If an accepted snapshot changes those definitions, publication preserves the saved work and asks a maintainer to publish it, or asks the requester to restore the definitions before requesting publication again. The check compares exact paths, modes, and blobs (including deleted definitions) with the published branch or original pull request base. Unchanged published definitions remain allowed. An update inherited unchanged from the authenticated target branch is also allowed when the published definition still matches their unambiguous common ancestor. Newly authored changes and conflicting resolutions still require full write authority, even when the result matches the target branch. Repository-only checkpoints cannot prove unambiguous inheritance from a source base that has diverged from the target, or infer a merge from previously copied workflow contents; those ambiguous updates still require a maintainer.

Local session-owned worktrees can use the same **Publish PR** action in the Control UI. The Gateway derives the managed worktree, repository, branch, base, and head from current session ownership. It never accepts those authority facts from the browser or model. Publication retries use a durable request ID, an exact commit marker, remote branch observation, and pull-request lookup by head branch so a Gateway restart or lost response does not create duplicate commits, pushes, or pull requests.

During publication, an accepted PR response still completes its owned receipt if the requesting connection closes or publication permission ends. A successful local branch update likewise finishes its matching index transaction while the execution retains workspace ownership. This settlement does not authorize another push or PR creation; unconfirmed outcomes retain their existing recovery or personal-confirmation requirements.

Before creating a publication commit or changing the local branch and index, the Gateway verifies that the accepted commit shares Git history with the authenticated pull request base, and that the published branch is absent or an ancestor of the accepted local head. Recreating a local branch or expiring its reflog does not invalidate shared commit history. A failed lookup is not treated as an absent branch. A rebased, behind, or unrelated branch is rejected with recovery guidance before new local publication changes. Recovery of an already-started request-owned index transaction still runs first. The push is conditional on the exact observed remote head or branch absence, so a concurrent branch change is rejected. The broker never rewrites published history or rewrites local history automatically.

To refresh an existing PR, preserve its published history and apply the intended edits on top of the published head. If rewritten history is intentional, use a new session branch and a replacement PR instead. Do not merge the old published history back merely to make a rebased branch pushable.

A separate request for unchanged content reuses an owned open PR without a new commit when the remote and local heads match, the accepted index and workspace match that tree, and the head already has a publication marker and all currently required contributor trailers. First publication still creates a request-owned marker, including for already-committed work; missing contributor credit also requires a new marker. Repository-only checkpoint publication already rejects unchanged published trees as `no_changes` and extends only its recorded published head. It cannot adopt external changes to that branch; publish the intended checkpoint from a new session branch if the recorded head no longer matches. These paths retain their existing retry and provenance contracts. For title/body-only edits, update the PR text directly rather than requesting workspace publication; reusing a PR does not update its text.

Verification proves which account answered the GitHub API request. Status reports the credential kind, access expiry, refresh availability, OAuth scopes, and Git author while distinguishing missing credentials, unverified transport failures, and GitHub rate limiting without returning `gh` diagnostics. Repository-specific grants remain unknown until an exact repository operation succeeds; `/user` does not prove write access.

Removing an agent override or choosing native credentials deletes the associated local refresh record after the config change. Already-running local processes may retain the old profile and its current access token until they exit, restart, or the token expires, while new runs use the updated identity immediately. This local change does not revoke the authorization at GitHub; revoke it separately from the OAuth application's GitHub settings when required.

Control UI issue and pull request hover previews use the selected agent's effective managed GitHub identity, including an inherited system identity. An unavailable managed identity produces an actionable error rather than switching to another credential. Without a managed selection, previews retain the optional `gateway.controlUi.github.token` service credential, shared `GH_TOKEN`/`GITHUB_TOKEN` environment fallback for `github.com`, and anonymous public access. Set `gateway.controlUi.github.host` to match `gateway.github.host` for Enterprise service access; an omitted credential host means `github.com`. Previews remain public-only, and their caches are scoped to the credential and host. Project discovery and clone use the configured system bot (or the unambiguous selected agent override), with the same refresh and current-selection checks. Without a configured bot, discovery retains its explicitly opted-in native identity or service credential. A configured but unavailable bot refuses access rather than borrowing a service, personal, native or anonymous credential. When this SecretRef is explicit, OpenClaw excludes its exact environment or store name from agent execution. A custom name does not clear unrelated `GH_TOKEN` or `GITHUB_TOKEN` values used by native identity; a ref named `GH_TOKEN` or `GITHUB_TOKEN` excludes that exact variable.

If a preview or detail view reports “GitHub request is no longer active,” open it again to retry. This describes the interrupted request, not a change to your GitHub account; reconnecting GitHub is unnecessary.

## GitHub App execution

Set `tools.github.kind` to `"app-installation"` to use a configured App installation
for repository execution. The existing agent override takes precedence over the
system selection. The `app` object supplies `appId`, `installationId`, `accountId`
(the installation owner), `repositories` (`id` and `fullName`), `permissions`,
`privateKey` (a Gateway SecretRef), and `keyVersion`. `gateway.github` continues to
own the host and API URL. Generate a new secret-free `profileId` when the key
version, installation or scope changes.

The trusted Gateway is the only issuance owner. It verifies the App, installation
owner, suspension, requested grants, bot identity and exact repository scope using
App and installation endpoints. It never verifies an installation token through
`/user`. Reads, checkout, native Codex, workers and publication use the scoped App
access token; configured App failure refuses execution without borrowing a human,
native, service or anonymous credential. Private run profiles retain the existing
renewal and cleanup contract. The App key stays on the Gateway and is excluded
from child environments and secret-store tool access.

Human sign-in, repository access admission, approval and contributor attribution
remain separate. Factory's private repository-admission endpoint returns only the
original actor, repository, installation and exact request binding with bounded
expiry. It never delivers the human execution bearer when App execution is
configured. A current original caller is required after awaited work and before
execution; expiry alone does not authorize an action. Existing interrupted effects
and publication receipts cannot switch identities.

`tools.github.status` reports the credential kind and sanitized `appInstallation`
facts (App, installation and owner IDs, repositories, permissions, suspension and
access expiry). These are verified issuer facts, not proof of a successful write.
Remote permission changes are reverified within five minutes or verified token
expiry, whichever comes first; reuse does not extend that interval. Removing the
selection fences new uses; existing child tokens expire at GitHub and private
execution copies are retired through their original run owner. Revoke the App at
GitHub when remote authorization must end immediately.

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
access token privately as `GH_TOKEN`, with `GITHUB_TOKEN` cleared. A missing,
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
