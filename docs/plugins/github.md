---
summary: "Read public GitHub issues, pull requests, commits, and comments beside chat"
title: "GitHub"
doc-schema-version: 1
read_when:
  - You want GitHub links to open beside your conversation
  - You need to enable or disable GitHub link previews and the reader
---

# GitHub

The bundled GitHub plugin adds public-repository link previews and a read-only
reader to the [Control UI](/web/control-ui). It is separate from the
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
an issue or pull request link to see its preview.

Each reader tab has its own Back and Forward history. Opening the same URL
selects its existing tab. Links inside the reader navigate the current tab;
the **+** button starts another tab. Up to ten tabs stay in memory. Closing the
page discards the documents and history. The reader follows the session panel’s
responsive layout; on a phone it can sit below chat or expand with the panel.

The reader includes descriptions, discussion comments, published inline PR
review comments with file and diff context, commit comments, and expandable
file diffs. Markdown images and standalone HTML image attachments can display
inline. The Gateway image policy permits GitHub user-attachment URLs and its
`user-images.githubusercontent.com` and `private-user-images.githubusercontent.com`
attachment hosts. They must support anonymous CORS; requests send no credentials
or referrer. Other or unavailable images retain a full-size external link.
Script and connection policies are unchanged; remote content cannot run scripts
or app widgets.

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
- Detail requests do not use ambient GitHub credentials. Preview metadata preserves
  the selected agent’s managed GitHub identity or the existing service/environment
  fallback when no managed identity is selected. Identity changes abort stale requests.
- Each comment collection is limited to 20 entries; PR discussion and inline
  review comments have separate limits. Up to 30 changed files are shown.
- Long text and patches are bounded. Incomplete content is labeled rather than
  presented as a complete conversation or diff.
- **Refresh** requests the current item again. Rate limits, deleted items, and
  unavailable services show a retry action and the external source link.

## Plugin author integration

GitHub uses the generic docked link-reader contribution in the
[Plugin SDK](/plugins/sdk-overview/host-hooks#docked-link-readers). The plugin owns URL matching, GitHub API
requests, caching, and mapping source data into the passive reader model. The
Control UI owns tabs, layout, safe rendering, and keyboard interaction.
