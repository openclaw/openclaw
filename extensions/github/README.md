# GitHub

Read public GitHub issues, pull requests, and commits beside your conversation in
OpenClaw. This official plugin is included with OpenClaw and enabled by default.

## What it adds

- Hover or focus issue and pull request links for a quick preview.
- Open supported GitHub links in the reader beside chat.
- Read descriptions, discussion and review comments, and expandable file diffs.
- Inspect pull request checks for the current head commit and refresh their status.
- Ask the agent to read a known public issue, pull request, or commit with `github_read`.
- Find public issues and pull requests in a chosen repository with `github_search`.

## Get started

Click a public GitHub issue, pull request, or commit link in chat. The reader opens
beside the conversation. Use **Open on GitHub** for the full page.

Manage the plugin from **Plugins → GitHub**. If you use a plugin allowlist, include
`github` in that list. Disabling the plugin removes previews and the reader;
GitHub links then open externally.

## Tools and access

The `github_read` agent tool accepts a supported `https://github.com/` item URL
and optional `refresh: true`. It returns the same bounded document as the reader,
including applicable comments, file changes, checks, and partial-result markers.
Requests use the invoking agent's Gateway-held identity, so sandboxed agents do
not need GitHub credentials or network access in their shells.

`github_search` requires `repository: "owner/repo"` and `kind: "issue" | "pull"`.
Search each kind separately when you need both; this also works with GitHub App
user tokens. Optional fields are plain-text `query` keywords,
`state: "all" | "open" | "closed"`, and `page` (1–50). It returns up to 20 matches,
most recently updated first.
Repeat the same filters with `nextPage` to continue; read a result URL with
`github_read`. `incomplete` reports an incomplete GitHub search, and `limited`
means more than GitHub's first 1,000 matches exist. Refine the filters in either
case. Query text cannot contain GitHub qualifiers, quotes, backslashes or parentheses.

Both tools are included in the coding profile and default sandbox allowlist. Explicit
tool allowlists and deny rules still apply; disabling the plugin removes both tools.
The plugin does not provide a GitHub Copilot model provider. Reading and search are limited to
public repositories and do not change issues, post comments, or merge pull
requests. Use **Open on GitHub** for private repositories or editing.

No GitHub sign-in is required for public content. When available, the reader uses
the selected agent's managed GitHub identity or the configured Control UI GitHub
token for API requests. GitHub rate limits still apply, and large discussions or
diffs can be incomplete; the reader marks those limits.

See the [GitHub plugin documentation](https://docs.openclaw.ai/plugins/github) for
reader behavior, access, and troubleshooting. For model access, see the separate
[GitHub Copilot provider](https://docs.openclaw.ai/providers/github-copilot).
