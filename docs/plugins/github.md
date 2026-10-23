---
summary: "Find public GitHub issues and pull requests, and read items beside chat"
title: "GitHub"
doc-schema-version: 1
read_when:
  - You want GitHub links to open beside your conversation
  - You need to enable or disable GitHub link previews and the reader
  - You want an agent to search a chosen public GitHub repository
---

# GitHub

The bundled GitHub plugin adds public-repository link previews and a read-only
reader to the [Control UI](/web/control-ui), plus the `github_read` and `github_search` agent tools. It is separate from the
[GitHub Copilot model provider](/providers/github-copilot).

## Upgrading with an existing plugin allowlist

GitHub previews that previously lived in core now belong to the bundled
`github` plugin. A nonempty `plugins.allow` list remains authoritative: if it
omits `github`, both hovercards and the reader stay unavailable, and links open
externally. OpenClaw does **not** add a plugin to an existing allowlist during
an upgrade or Doctor repair.

To restore previews, append `github` to your **existing** `plugins.allow` list
without removing its other entries, then enable GitHub in **Plugins**. Keep
`plugins.deny` and explicit disabled entries consistent with your choice. Doctor
explains this recovery when an implicit allowlist exclusion blocks the feature.
To intentionally keep it off and silence that notice, set
`plugins.entries.github.enabled: false`.

## Read an item beside chat

The plugin is enabled by default. Connect to the Gateway, then click a public
GitHub issue, pull request, or commit link in chat. The reader opens beside the
conversation with a GitHub icon and an **Open on GitHub** link. Hover or focus
an issue or pull request link to see its preview. Issue and pull request chips
show the full `owner/repo#number` reference, including shorthand references
resolved from the session repository. Descriptive link labels stay unchanged.
Login, OAuth, profile,
repository, and other general GitHub pages remain ordinary links: neither
native item previews nor the generic page-preview fallback fetches them.
A PR or issue URL inside a login redirect query does not make the login link
previewable.

Each reader tab has its own Back and Forward history. Opening the same URL
selects its existing tab. Links inside the reader navigate the current tab;
the **+** button starts another tab. Up to ten tabs stay in memory. Closing the
page discards the documents and history. The reader follows the session panel’s
responsive layout; on a phone it can sit below chat or expand with the panel.

The reader shows the title and description first, while checks and discussion
load independently. A quiet skeleton keeps the layout recognizable on a cold
open. File diffs load when you select **Files** or scroll near that section.
The reader includes discussion comments, published inline PR review comments
with file and diff context, commit comments, and expandable file diffs. The
header separates the item state, author, change counts, and PR branches. **Overview**, **Checks**, **Files**, and **Discussion** shortcuts jump
to the relevant section without leaving the reader.

Pull requests show check runs and commit statuses for the exact head commit.
Expand the checks summary to inspect individual results and open their source
logs. Failed checks expand by default. Pending, failed, passed, skipped, empty,
and unavailable results remain distinct; a partial response never implies that
all checks passed. These results describe CI, not approval or merge readiness.
Use **Refresh** to fetch the current PR and its checks again. The previous
document stays readable while refreshing, with previous results labeled until
replaced. A changed head never inherits checks or diffs from the old head.
Retryable section failures stay beside the affected content; access or identity
failures clear the document.

Descriptions and replies render named emoji shortcodes such as `:white_check_mark:`
and `:rocket:` in prose, tables, link labels, and disclosure summaries. Code, URLs,
unknown shortcodes, and plain emoticons such as `:)` stay literal.

HTML comments in descriptions and replies stay hidden, matching
GitHub; literal comment examples inside code remain visible.
Markdown images and standalone HTML image attachments can display inline. The
GitHub plugin fetches public user attachments anonymously through the Gateway,
including GitHub's attachment redirects, so they do not need browser CORS headers.
Requests send no GitHub credentials, cookies, or referrer. PNG, JPEG, GIF, and WebP
attachments up to 2 MiB are supported by the resolver. If resolution fails, the
reader preserves the original anonymous-CORS image path; images that still
cannot load retain a full-size external link. Each loaded document bounds concurrent requests and
cached image data; closing its tab or replacing the document retires that cache.
Script and connection policies are unchanged; remote content cannot run scripts
or app widgets.

## Ask the agent to read an item

Give the agent a public GitHub issue, pull request, commit, or Actions workflow-job URL. The
`github_read` tool reads it through the Gateway and returns the title, description,
applicable discussion and review comments, file changes, and pull request checks.
It accepts `url` and optional `refresh: true` to fetch current content.

For an Actions URL such as
`https://github.com/OWNER/REPO/actions/runs/RUN_ID/job/JOB_ID`, the reader returns
the completed job's name, run/job IDs, conclusion, commit SHA, and complete lines
from the last 64 KiB of its log. Earlier output is explicitly marked omitted with
`partial` and `bodyTruncated`. Logs are fetched fresh, redacted, and treated as
untrusted content; they do not establish that omitted output was read. Running,
expired, deleted, or inaccessible logs return an error. GitHub may require the
selected identity to have Actions read access even for a public job. The Gateway
keeps download URLs and credentials private. Job links in the UI continue to open
on GitHub; this tool does not rerun jobs or download log archives.

This tool works for permitted sandboxed agents without GitHub credentials or
outbound network access inside the sandbox. The Gateway selects the invoking
agent's managed identity, or uses the same service-token/anonymous fallback as
the reader. The tool cannot select another agent or expose the credential.
Current invocation, tool and identity authority remain required through delivery,
including cached reads.

`github_read` is included in the coding profile and default sandbox tool allowlist.
Explicit tool allowlists and deny rules remain authoritative. If you maintain a
custom sandbox allowlist, include `github_read` to permit it. Disabling `github`
removes the tool as well as the UI reader. The tool reads known references; it
does not search, post, edit or merge GitHub content.

The same limits below apply. Inspect `partial`, `bodyTruncated`,
`commentsTruncated`, `filesTruncated`, and individual comment/patch/check markers;
a bounded result does not establish that the full discussion or diff was read.

## Ask the agent to find issues or pull requests

Use `github_search` with a chosen public `repository` such as `openclaw/openclaw`.
Choose `kind: "issue"` or `kind: "pull"` for each call. Search each kind separately
when you need both; GitHub App user tokens require a single kind per query.
Optional `query` keywords match text, and `state` selects `all`, `open`, or `closed`.
Omit the query to use just the filters. Query text is literal: GitHub qualifiers, quotes, backslashes and
parentheses are not accepted, and Boolean words cannot widen the repository scope.
The quoted keywords must fit GitHub's 256-character search limit; use fewer or
shorter words if the tool rejects a long query.

Each call returns up to 20 items, sorted by most recently updated first, with
URLs that `github_read` can open. Start at `page: 1`, then repeat the same filters
with the returned `nextPage`. A null `nextPage` ends the available pages.
`incomplete: true` means GitHub did not finish the search; `limited: true` means
more than its first 1,000 matches exist. Refine the query or filters instead of
assuming either result is exhaustive. Results can move between pages as issues
and pull requests change on GitHub.

Search uses the same Gateway-held identity and current invocation authority as
reading. The selected repository must be public before the search and before
its results are delivered. The tool is included in the coding profile and
default sandbox allowlist; add `github_search` to a custom allowlist if needed.
Explicit deny rules and plugin disablement still apply. Rate-limit errors include
GitHub's retry delay when available. Search does not discover repositories,
search private content, post, edit, or merge.

## Enable or disable the plugin

Open **Plugins** in the Control UI to manage the GitHub plugin. The corresponding
configuration is:

```json5
{
  plugins: {
    entries: {
      github: { enabled: false },
    },
  },
}
```

Apply the configuration through the normal Gateway configuration flow. Capability
updates remove disabled readers without requiring a browser reconnect. When disabled, the plugin contributes no reader or
hovercard, and GitHub links open externally.

## Limits and unavailable content

- The reader is public-only and read-only. Use **Open on GitHub** for private
  repositories, posting comments, or merging pull requests.
- Previews and reader documents use the selected agent’s managed GitHub identity,
  or the configured Control UI GitHub token and Gateway environment fallback when
  no managed identity is selected. Without credentials they use GitHub’s shared
  anonymous IP quota. Authenticated documents remain public-only: the reader checks
  repository visibility and identity before returning fresh or cached content.
  Identity changes abort stale requests. Attachment images remain anonymous.
- Each comment collection is limited to 20 entries; PR discussion and inline
  review comments have separate limits. Up to 30 changed files are shown.
- PR checks use at most one page each of check runs and commit statuses and show
  up to 100 results. Incomplete or unavailable checks retain a link to GitHub.
- Long text and patches are bounded. Incomplete content is labeled rather than
  presented as a complete conversation or diff.
- Uncached hover previews share a two-second upstream request budget. Slow avatars
  or co-author lookups are omitted; slow required metadata returns a retryable
  unavailable error. The full reader keeps its longer request timeout.
- Hover previews are shared for one minute across readers using the same GitHub
  identity. Concurrent requests share a fetch, but each reader must still have
  access when the result arrives. Expired previews can appear with a stale marker
  while one background refresh runs. The hovercard displays that cached response
  immediately; reopening or prefetching it after the 30-second stale-cache backoff
  reads the refreshed metadata. An already-open card does not poll for updates.
  Cached delivery checks the current credential
  once; each upstream dispatch also checks it. **Refresh** waits for current metadata.
  Refreshes use GitHub ETags for unchanged item and commit responses; identity
  changes, eviction, or a failed refresh retire those cached responses. Repository
  visibility is checked again for every authenticated refresh.
  Anonymous author and coauthor avatars are shared across previews for five minutes,
  including concurrent reads and previews of different items. Expired images remain
  visible while one background refresh runs; updated images appear with a subsequent
  preview load. Metadata and repository access checks remain scoped to the selected
  GitHub identity.
- Slow preview reads (500 ms or longer) log phase durations for identity preparation,
  cache/load wait, delivery credential checks, metadata rendering, optional decoration,
  and upstream authentication/network waits. Network timings cover response headers;
  metadata/decorations include response-body reads. These diagnostics omit URLs,
  item contents, and credentials.
- **Refresh** requests the current item again. Rate limits, deleted items, and
  unavailable services show their specific explanation in the reader and hovercards,
  including GitHub's retry delay when available. Cached preview details stay visible
  with the failure notice. Use the reader's **Retry** action or **Open on GitHub**;
  the server's API quota is separate from your signed-in browser session.

## Plugin author integration

GitHub uses the generic docked link-reader contribution in the
[Plugin SDK](/plugins/sdk-overview/host-hooks#docked-link-readers). The plugin owns URL matching, GitHub API
requests, caching, and mapping source data into the passive reader model. The
Control UI owns tabs, layout, safe rendering, and keyboard interaction.

## Session-bound Enterprise previews

When `gateway.github.host` selects an Enterprise host, the plugin also advertises
an exact-host, session-scoped reader. It uses the foreground session's repository
and the selected GitHub App identity. Factory requests require the current signed-in
operator's `session-item-read` proof and existing repository admission; a pasted
URL cannot select another repository or borrow a different person's credentials.

Private previews finish under that request's authority. Their UI cache is scoped
to the connection, agent, and session; document caches also include the host,
repository, and prepared reader identity. Access denial stays an error, rather than
falling back to anonymous page metadata. Repository redirects require reopening
an updated session target. Public `github.preview`, `github_read`, and
`github_search` retain their public-repository contracts.
