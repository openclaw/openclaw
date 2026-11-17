---
summary: "Plugin repository discovery and managed local checkout"
title: "Repository sources"
read_when:
  - Adding a repository host integration through a plugin
  - Preparing plugin repository sources for local sessions
---

# Repository sources

A repository plugin contributes discovery metadata and registers a source through
`api.registerRepositorySource(source)`. Import `RepositorySourceV1` and its
preparation types from `openclaw/plugin-sdk/repository-sources`.

The manifest declares the local contribution ID and an advertised Gateway search
method:

```json
{
  "repositorySources": [
    {
      "id": "repositories",
      "label": "Example Forge",
      "searchMethod": "example.repositories.search"
    }
  ]
}
```

Register that method using `api.registerGatewayMethod`. Its result follows the
existing remote-project search shape: `projects` contains repository names,
clone/web URLs, visibility, and optional description/default branch; `credential`
describes availability without returning a credential. Discovery is backend
metadata and does not require a plugin browser module or custom UI enablement.

## Selection and local preparation

The picker shows plugin source groups alongside the existing native search.
Selecting a result carries the qualified `pluginId/contributionId` as the optional
`sessions.create.repositorySource`, alongside `projectGitUrl` or `repository`.
An explicit source that is disabled, withdrawn, or does not accept the URL fails
with an actionable error; it never falls back to another account or source.
Requests without that field retain their existing native behavior.

The registered source supplies:

- `resolve(url)`: admit and normalize a supported remote URL.
- `prepare({ url, agentId, requiredCommit, signal, assertCurrent })`: prepare a
  project and return its project identity/root, an `assertCurrent` callback, and
  `resolveBase(ref?)` returning `{ commit, ref }` for host-owned worktree preparation.
  Without a ref, observe the current remote default and hydrate its commit through
  source transport, including a renamed default branch; return `origin/<branch>`
  as its ref. Explicit refs are resolved locally first; the source is consulted
  only when the chosen ref is missing, so it must hydrate a missing branch, tag or
  full commit, not only branches. Credentials stay in the source closure.

Use `createManagedProjectCheckoutV1(transport)` when the source needs managed
clones. Its `materialize()` and `refresh()` operations reuse the existing checkout
leases, storage layout, and project registry. Its `resolveBase(project, ref, options)`
operation holds the same checkout lease and passes current authority to the
transport's `resolveBase({ url, target, ref }, options)`. The host independently
verifies the returned commit locally, retains safe local-default fast-forward
checks, and records the selected ref and immutable commit before setup. Retries
reuse that pin without selecting or fetching a new base. The transport supplies URL
resolution and authenticated clone, commit-fetch, and refresh operations; it does
not choose host storage or maintain another registry. If `clone` fails, the host
removes the unregistered target so a retry starts clean, unless the failure left a
Git process whose cleanup is uncertain. Call these operations from
the source's managed plugin invocation so the host can bind current Gateway
configuration and plugin authority.

The session and worktree owners retain preparation, source binding, cancellation,
and commit custody. Providers must call the supplied assertion immediately before
external effects and honor cancellation. Registration binds callbacks and returned
operations to the managed plugin lifetime; a retained reference cannot revive a
retired source.

## Cloud workers

Plugin repository sources run sessions on the Gateway only. A `sessions.create`
request that combines `repositorySource` with a cloud `repository` workspace is
rejected with a message asking for a local placement. A later stage adds cloud
preparation together with the first source that uses it.

## Compatibility

Existing plugins need no new registration or manifest fields. Native repository
selection, URLs, saved source snapshots, and GitHub identity/publication owners
remain in place when no plugin source is selected. This capability does not
migrate existing GitHub account/configuration records or replace native tools.

Managed-checkout transports can reuse `configureProjectCheckoutMaintenance` from
`openclaw/plugin-sdk/process-runtime` when adopting an existing clone. Each
transport call receives `startRun`; run every Git command through it so the host
rechecks its checkout leases immediately before the command starts. The same
entrypoint exports `executeGitCommand`, `requireGitCommandOutput`,
`runProjectGitCommand` and `projectCheckoutGitEnvironment` for that purpose. The
bundled [GitLab plugin](/plugins/gitlab) is a complete example. It uses the
host maintenance settings, bounded Git process runner, cancellation and current
authority assertion; the transport still owns authentication and remote policy.
