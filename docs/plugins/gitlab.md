---
summary: "Start sessions from public GitLab repositories"
title: "GitLab"
doc-schema-version: 1
read_when:
  - You want to start a session from a GitLab repository
  - You are configuring a self-managed GitLab server for repository search
---

# GitLab

The bundled GitLab plugin adds GitLab as a repository source in **New session**.
Search finds public projects on the configured GitLab server, and choosing one
clones it into a managed checkout, the same way OpenClaw prepares a GitHub
repository. Built-in GitHub repositories are unaffected.

## Enable it

The plugin is included with OpenClaw and off by default. Enable it in
**Plugins**, or in config:

```json
{
  "plugins": {
    "entries": {
      "gitlab": { "enabled": true }
    }
  }
}
```

Then open **New session**, type at least two characters of a project name in
the repository picker, and choose a result under **GitLab**. Pasting a URL
into the picker still selects the built-in GitHub path, so choose GitLab
projects from search.

## Self-managed GitLab

Point the plugin at your server's HTTPS address:

```json
{
  "plugins": {
    "entries": {
      "gitlab": { "enabled": true, "config": { "baseUrl": "https://gitlab.example.com" } }
    }
  }
}
```

Only HTTPS server addresses without a path are accepted. Project URLs must be
on the same server.

## Current limits

- Public projects only. The plugin sends no GitLab credentials for search or
  clone.
- Local sessions only. Cloud workers report that this source cannot prepare
  cloud workspaces.
- No merge requests yet; sessions can change files but not publish to GitLab.

Plugin authors can build their own repository sources with
[Repository sources](/plugins/sdk-repository-sources).
