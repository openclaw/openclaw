---
title: "Diffs"
summary: "Read-only diff viewer and PNG renderer for agents (optional plugin tool)"
description: "Use the optional Diffs plugin to render before/after text or unified patches as a gateway-hosted diff view or a PNG."
read_when:
  - You want agents to show code or markdown edits as diffs
  - You want a canvas-ready viewer URL or a rendered diff PNG
---

# Diffs

`diffs` is an **optional plugin tool** that renders a read-only diff from either:

- arbitrary `before` / `after` text
- a unified patch

The tool can produce:

- a gateway-hosted viewer URL for canvas use
- a PNG image for message delivery
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
- `mode: "image"` returns `details.imagePath` only
- `mode: "both"` returns the viewer details plus `details.imagePath`

Typical agent patterns:

- open `details.viewerUrl` in canvas with `canvas present`
- send `details.imagePath` with the `message` tool using `path` or `filePath`

## Tool inputs

Before/after input:

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

- `mode`: `view`, `image`, or `both`
- `layout`: `unified` or `split`
- `theme`: `light` or `dark`
- `expandUnchanged`: expand unchanged sections instead of collapsing them
- `path`: display name for before/after input
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
            layout: "unified",
            wordWrap: true,
            background: true,
            theme: "dark",
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
- `layout`
- `wordWrap`
- `background`
- `theme`
- `mode`

Explicit tool parameters override the plugin defaults.

## Notes

- Viewer pages are hosted locally by the gateway under `/plugins/diffs/...`.
- Viewer artifacts are ephemeral and stored locally.
- `mode: "image"` uses a faster image-only render path and does not create a viewer URL.
- PNG rendering requires a Chromium-compatible browser. If auto-detection is not enough, set `browser.executablePath`.
- Diff rendering is powered by [Diffs](https://diffs.com).

## Related docs

- [Tools overview](/tools)
- [Plugins](/tools/plugin)
- [Browser](/tools/browser)
