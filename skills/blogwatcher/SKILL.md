---
name: blogwatcher
description: Monitor blogs and RSS/Atom feeds for updates using the blogwatcher CLI.
homepage: https://github.com/Hyaxia/blogwatcher
metadata: {"clawdis":{"emoji":"📰","requires":{"bins":["blogwatcher"]},"install":[{"id":"go","kind":"go","module":"github.com/Hyaxia/blogwatcher@latest","bins":["blogwatcher"],"label":"Install blogwatcher (go)"}]}}
---

# blogwatcher

Track blog and RSS/Atom feed updates with the `blogwatcher` CLI.

Install
- Go: `go install github.com/Hyaxia/blogwatcher@latest`

Quick start
- `blogwatcher --help`

Common commands
- Add a feed: `blogwatcher add "https://example.com/feed.xml"`
- List feeds: `blogwatcher list`
- Check for updates: `blogwatcher check`
- Remove a feed: `blogwatcher remove "https://example.com/feed.xml"`

Example output
```
$ blogwatcher list
- https://example.com/feed.xml
```
```
$ blogwatcher check
Found 1 new post:
- "Example Post Title" (https://example.com/posts/example-post)
```

Notes
- Use the CLI help output to discover available subcommands and flags.
