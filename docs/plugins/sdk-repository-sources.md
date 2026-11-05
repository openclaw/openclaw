---
summary: "Plugin repository discovery, checkout, and cloud workspace preparation"
title: "Repository sources"
read_when:
  - Adding a repository host integration through a plugin
  - Preparing plugin repository sources for local or cloud sessions
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
  only when the chosen ref is missing. Credentials stay in the source closure.

Use `createManagedProjectCheckoutV1(transport)` when the source needs managed
clones. Its `materialize()` and `refresh()` operations reuse the existing checkout
leases, storage layout, and project registry. Its `resolveBase(project, ref, options)`
operation holds the same checkout lease and passes current authority to the
transport's `resolveBase({ url, target, ref }, options)`. The host independently
verifies the returned commit locally, retains safe local-default fast-forward
checks, and records the selected ref and immutable commit before setup. Retries
reuse that pin without selecting or fetching a new base. The transport supplies URL
resolution and authenticated clone, commit-fetch, and refresh operations; it does
not choose host storage or maintain another registry. Call these operations from
the source's managed plugin invocation so the host can bind current Gateway
configuration and plugin authority.

The session and worktree owners retain preparation, source binding, cancellation,
and commit custody. Providers must call the supplied assertion immediately before
external effects and honor cancellation. Registration binds callbacks and returned
operations to the managed plugin lifetime; a retained reference cannot revive a
retired source.

## Cloud preparation and recovery

Cloud support is optional. A source with a `worker` adapter supplies immutable
repository/object identities, an opaque nonsecret `identityKey`, tree/blob reads,
access revalidation, authenticated Git-pack preparation, and checkout. These
operations feed the existing recipe, provisioning, and workspace owners. A source
without that adapter reports that cloud preparation is unavailable.

Without `prepareGitPack`, the worker fetches an admitted public HTTPS URL
without ambient credentials or redirects. Other transports require a source-owned
pack. Pack installation preserves the admitted HTTPS, SSH, or SCP-style origin
without contacting it; repository hosts and nested paths remain source-owned.

`identityKey` partitions prepared content; it does not authorize access. Returned
facts contain no account records or bearer credentials. Providers revalidate
current access and repository identity at the supplied boundaries. The host
retains the selected source and pinned commit through dispatch, restart, and
Gateway recovery.

Prepared-worker retention uses the source's optional `worker.isIdentityCurrent`
callback for its saved identity key, not native GitHub account selection. The
callback is a local selection check and must not acquire credentials or remote
access. Sources without it do not retain prepared workers; source retirement or
an identity change makes existing preparations ineligible for reuse.

Worker preparation and checkout can receive an optional `readCredential` capability
from the admitted dispatch owner. It retains its current-actor assertion and
admission operation; a plugin must not replace required dispatch admission with
stored credentials. When `retainCredentialCleanup` is supplied, register each
issued credential's revocation callback immediately so the host can clean it up
when the accepted work ends. These callbacks do not become prepared metadata.

The host revalidates the worker lease before and after `prepareGitPack`. The
provider keeps current caller and captured credential assertions at each transport
effect; it does not repeat the host's remote lease revalidation.

Cold checkout uses a host-owned one-use `RepositoryCheckoutTransfer`. Pass it to
`performRepositoryCheckout` with transport authorization when needed. The transfer
selects the operation and destination; a plugin does not receive the workspace
transport or gain authority to redirect it. Credentials supplied to that effect
are neither returned as source metadata nor persisted in prepared snapshots.

## Compatibility

Existing plugins need no new registration or manifest fields. Native repository
selection, URLs, saved source snapshots, and GitHub identity/publication owners
remain in place when no plugin source is selected. This capability does not
migrate existing GitHub account/configuration records or replace native tools.

Managed-checkout transports can reuse `configureProjectCheckoutMaintenance` from
`openclaw/plugin-sdk/process-runtime` when adopting an existing clone. It uses the
host maintenance settings, bounded Git process runner, cancellation and current
authority assertion; the transport still owns authentication and remote policy.
