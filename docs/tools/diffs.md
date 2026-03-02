---
title: "Diffs"
summary: "Read-only diff viewer and file renderer for agents (optional plugin tool)"
description: "Use the optional Diffs plugin to render before and after text or unified patches as a gateway-hosted diff view, a file (PNG or PDF), or both."
read_when:
  - You want agents to show code or markdown edits as diffs
  - You want a canvas-ready viewer URL or a rendered diff file
---

# Diffs

`diffs` is an **optional plugin tool** that renders a read-only diff from either:

- arbitrary `before` and `after` text
- a unified patch

The tool can produce:

- a gateway-hosted viewer URL for canvas use
- a rendered file artifact (PNG or PDF) for message delivery
- both outputs together

## Enable the plugin

```json5
{
  plugins: {
    entries: {
      diffs: {
        enabled: true,
      },
    },
  },
}
```

## What agents get back

- `mode: "view"` returns `details.viewerUrl` and `details.viewerPath`
- `mode: "file"` returns `details.filePath`
- `mode: "both"` returns the viewer details plus `details.filePath`
- file-producing modes also return `details.fileFormat` (`png` or `pdf`)

Typical agent patterns:

- open `details.viewerUrl` in canvas with `canvas present`
- send `details.filePath` with the `message` tool using `path` or `filePath`

## Tool inputs

Before and after input:

```json
{
  "before": "# Hello\n\nOne",
  "after": "# Hello\n\nTwo",
  "path": "docs/example.md",
  "mode": "view"
}
```

Patch input:

```json
{
  "patch": "diff --git a/src/example.ts b/src/example.ts\n--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1 +1 @@\n-const x = 1;\n+const x = 2;\n",
  "mode": "both"
}
```

Useful options:

- `mode`: `view`, `file`, or `both`
- `layout`: `unified` or `split`
- `theme`: `light` or `dark`
- `fileFormat`: `png` or `pdf` (default: `png`)
- `fileQuality`: `standard`, `hq`, or `print` (file mode only)
- `fileScale`: override file device scale factor (`1`-`4`)
- `fileMaxWidth`: override file max width in CSS pixels (`640`-`2400`)
- `expandUnchanged`: expand unchanged sections instead of collapsing them
- `path`: display name for before and after input
- `title`: explicit diff title
- `ttlSeconds`: viewer artifact lifetime
- `baseUrl`: override the gateway base URL used in the returned viewer link

## Plugin defaults

Set plugin-wide defaults in `~/.openclaw/openclaw.json`:

```json5
{
  plugins: {
    entries: {
      diffs: {
        enabled: true,
        config: {
          defaults: {
            fontFamily: "Fira Code",
            fontSize: 15,
            lineSpacing: 1.6,
            layout: "unified",
            showLineNumbers: true,
            diffIndicators: "bars",
            wordWrap: true,
            background: true,
            theme: "dark",
            fileFormat: "png",
            fileQuality: "standard",
            fileScale: 2,
            fileMaxWidth: 960,
            mode: "both",
          },
        },
      },
    },
  },
}
```

Supported defaults:

- `fontFamily`
- `fontSize`
- `lineSpacing`
- `layout`
- `showLineNumbers`
- `diffIndicators`
- `wordWrap`
- `background`
- `theme`
- `fileFormat`
- `fileQuality`
- `fileScale`
- `fileMaxWidth`
- `mode`

Explicit tool parameters override the plugin defaults.

Compatibility note: `defaults.format` is accepted as an alias for `defaults.fileFormat`.

## Notes

- Viewer pages are hosted locally by the gateway under `/plugins/diffs/...`.
- Viewer artifacts are ephemeral and stored locally.
- `mode: "file"` uses a faster file-only render path and does not create a viewer URL.
- File quality presets include hard pixel caps to prevent runaway renders on very large diffs.
- PNG or PDF rendering requires a Chromium-compatible browser. If auto-detection is not enough, set `browser.executablePath`.
- Diff rendering is powered by [Diffs](https://diffs.com).

## Related docs

- [Tools overview](/tools)
- [Plugins](/tools/plugin)
- [Browser](/tools/browser)
