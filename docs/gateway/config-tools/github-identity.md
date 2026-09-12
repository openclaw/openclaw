---
summary: "tools.github: the shared managed GitHub CLI identity, its refresh, and its execution boundaries"
read_when:
  - Giving agents a shared managed `gh` identity instead of native credentials
  - Checking which execution paths receive the launch-bound credential
  - Setting the Git author for agent commits
title: "Configuration — GitHub identity for agent tools"
---

`tools.github` selects the shared managed GitHub CLI identity used by agent execution, and defines which execution paths receive its credential.

## `tools.github`

GitHub CLI identity is native by default. When `tools.github` is omitted, local agent tools, the Codex harness, and Agent Settings follow normal `gh` resolution: `GH_TOKEN` or `GITHUB_TOKEN` from the Gateway process takes precedence, followed by the runtime user's `gh` keyring/config. The Git author comes from the selected agent's workspace.

Use **Settings → Profile → GitHub connections** to see **My GitHub** and **System GitHub** together. Administrators explicitly choose **For the system** to configure this shared execution identity; the general connection flow defaults to **For me** for identified users. Per-agent overrides remain an advanced administrative setting under **Agents → Tools**. A personal connection is separate from `tools.github`: it supports explicitly selected Gateway-brokered publication and does not change agent shell credentials, shared defaults, or verified sign-in identity. See [GitHub connections](/concepts/user-model#github-connections).

OpenClaw displays a one-time user code with a **Copy code** button beside it; clicking the code selects it in full for manual copying. Open the fixed `https://github.com/login/device` link, paste the code, and approve `repo`, `workflow`, `read:org`, and `gist`. The latter two are part of GitHub CLI's minimum classic-token contract. The Gateway owns the device code, token exchange, account verification, private managed `gh` profile, and rotating refresh token. Setup and refresh do not return credentials in browser responses or place them in config, logs, command arguments, transcripts, or the model runtime environment. OpenClaw-owned local exec receives an access token only through its private process-launch environment, as described below.

OAuth access tokens expire after about eight hours. The Gateway refreshes them before expiry, verifies the durable GitHub account ID, and atomically replaces the credential inside the same private profile. New local exec launches use the refreshed credential; an already-running local exec keeps its launch token until it exits. Restart a long-running shell after its access token expires. An expired or rejected refresh token is shown as **Reconnect required**. Refresh never blocks Gateway startup.

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

For OpenClaw-owned `exec` with `host=gateway`, including Pi `exec` and Codex `gateway_exec`, the local launch owner reads and validates the selected profile immediately before each process launch. It places that access token in `GH_TOKEN` only in the private child environment and clears `GITHUB_TOKEN`; approval payloads and shared run environments remain non-secret. A missing, tokenless, or insecure profile refuses the local execution before the command starts instead of permitting native-keyring fallback. This also applies to commands that might invoke `gh` indirectly. Reconnect or change the GitHub Identity selection before retrying. A launched command retains its selected credential even if the profile later disappears; the next exec launch reads the profile again.

**Codex-native shell is a separate boundary.** Native `exec_command` and shell execution still receive the non-secret profile overlay, not the private launch-time credential binding. `GH_CONFIG_DIR` does not isolate the OS keyring: if the selected profile disappears or loses its token, GitHub CLI can fall back to native keyring credentials. Use `gateway_exec` when the launch-bound managed identity guarantee is required. GitHub status and Gateway-owned publication guarantees do not extend to native shell execution.

Choosing a different identity or inheritance target selects another profile for new runs. An admitted run keeps its prior profile selection, and already-launched local exec processes keep their launch token until they exit. Retired profile files are cleaned on the next Gateway restart, so changing this setting is not immediate credential revocation.

Managed profiles provide execution and coordination identity; they are not an OS-user security sandbox. A process with unrestricted host execution under the same OS account can access account-owned files, including managed `gh` profiles. Use an OpenClaw sandbox, a dedicated host, or a dedicated OS user when adversarial isolation is required.

OpenClaw `worker-turn` cloud workers receive the effective shared identity per turn through their private launch envelope. The worker writes the access token to a private per-turn profile in its throwaway state directory, with earlier profiles removed before the next binding; the same OS-user limit described above applies on the worker host. The sealed worker launcher gives each `exec` child the same launch-time credential binding as local exec. GitHub CLI must be installed on the worker host; the bundle includes the launcher, not `gh`. The checkout uses the session-owned branch and an HTTPS `origin` for GitHub repositories; HTTPS Git authentication uses `gh auth git-credential`, with inherited credential helpers cleared. Commits and pushes happen directly on the worker. Reconciliation returns file contents to the Gateway worktree, not commit history. At every turn start, the worker fast-forwards its checkout to the session branch on `origin` when the local branch is behind, bringing in history pushed by an earlier worker; a diverged local branch is left untouched. Paired devices' own GitHub CLI logins are not used for this binding.

OpenClaw sandboxes, ordinary node-host exec, and Codex `remote-exec` placements still do not receive the Gateway's managed GitHub credentials. The `github_publish` tool remains available for remote-exec sessions: it records a bounded publication request without credentials or repository authority. After the exact workspace result is reconciled and accepted, the Gateway commits remaining changes as the verified effective GitHub user, pushes the authoritative session branch through a one-shot HTTPS credential helper, and creates or reuses a draft pull request.

Local session-owned worktrees can use the same **Publish PR** action in the Control UI. The Gateway derives the managed worktree, repository, branch, base, and head from current session ownership. It never accepts those authority facts from the browser or model. Publication retries use a durable request ID, an exact commit marker, remote branch observation, and pull-request lookup by head branch so a Gateway restart or lost response does not create duplicate commits, pushes, or pull requests.

Verification proves which account answered the GitHub API request. Status reports the credential kind, access expiry, refresh availability, OAuth scopes, and Git author while distinguishing missing credentials, unverified transport failures, and GitHub rate limiting without returning `gh` diagnostics. Repository-specific grants remain unknown until an exact repository operation succeeds; `/user` does not prove write access.

Removing an agent override or choosing native credentials deletes the associated local refresh record after the config change. Already-running local processes may retain the old profile and its current access token until they exit, restart, or the token expires, while new runs use the updated identity immediately. This local change does not revoke the authorization at GitHub; revoke it separately from the OAuth application's GitHub settings when required.

Control UI issue and pull request hover previews use the selected agent's effective managed GitHub identity, including an inherited system identity. An unavailable managed identity produces an actionable error rather than switching to another credential. Without a managed selection, previews retain the optional `gateway.controlUi.github.token` service credential, shared `GH_TOKEN`/`GITHUB_TOKEN` environment fallback, and anonymous public access. Previews remain public-only, and their caches are scoped to the credential used. Project discovery continues to use the separate service credential. When this SecretRef is explicit, OpenClaw excludes its exact environment or store name from agent execution. A custom name does not clear unrelated `GH_TOKEN` or `GITHUB_TOKEN` values used by native identity; a ref named `GH_TOKEN` or `GITHUB_TOKEN` excludes that exact variable.
