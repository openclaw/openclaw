---
title: "Diffs"
summary: "Read-only diff viewer and PNG renderer for agents (optional plugin tool)"
description: "Use the optional Diffs plugin to render before or after text or unified patches as a gateway-hosted diff view, a PNG image, or both."
read_when:
  - You want agents to show code or markdown edits as diffs
  - You want a canvas-ready viewer URL or a rendered diff PNG
  - You need controlled, temporary diff artifacts with secure defaults
---

# Diffs

`diffs` is an optional plugin tool that turns change content into a read-only diff artifact for agents.

It accepts either:

- `before` and `after` text
- a unified `patch`

It can return:

- a gateway viewer URL for canvas presentation
- a rendered PNG path for message delivery
- both outputs in one call

## Quick start

1. Enable the plugin.
2. Call `diffs` with `mode: "view"` for canvas-first flows.
3. Call `diffs` with `mode: "image"` for chat/image-first flows.
4. Call `diffs` with `mode: "both"` when you need both artifacts.

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

## Typical agent workflow

1. Agent calls `diffs`.
2. Agent reads `details` fields.
3. Agent either:
   - opens `details.viewerUrl` with `canvas present`
   - sends `details.imagePath` with `message` using `path` or `filePath`
   - does both

## Input examples

Before and after:

```json
{
  "before": "# Hello\n\nOne",
  "after": "# Hello\n\nTwo",
  "path": "docs/example.md",
  "mode": "view"
}
```

Patch:

```json
{
  "patch": "diff --git a/src/example.ts b/src/example.ts\n--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1 +1 @@\n-const x = 1;\n+const x = 2;\n",
  "mode": "both"
}
```

## Tool input reference

All fields are optional unless noted:

- `before` (`string`): original text. Required with `after` when `patch` is omitted.
- `after` (`string`): updated text. Required with `before` when `patch` is omitted.
- `patch` (`string`): unified diff text. Mutually exclusive with `before` and `after`.
- `path` (`string`): display filename for before and after mode.
- `lang` (`string`): language override hint for before and after mode.
- `title` (`string`): viewer title override.
- `mode` (`"view" | "image" | "both"`): output mode. Defaults to plugin default `defaults.mode`.
- `theme` (`"light" | "dark"`): viewer theme. Defaults to plugin default `defaults.theme`.
- `layout` (`"unified" | "split"`): diff layout. Defaults to plugin default `defaults.layout`.
- `expandUnchanged` (`boolean`): expand unchanged sections.
- `ttlSeconds` (`number`): viewer artifact TTL in seconds. Default 1800, max 21600.
- `baseUrl` (`string`): viewer URL origin override. Must be `http` or `https`, no query/hash.

Validation and limits:

- `before` and `after` each max 512 KiB.
- `patch` max 2 MiB.
- `path` max 2048 bytes.
- `lang` max 128 bytes.
- `title` max 1024 bytes.
- Patch complexity cap: max 128 files and 120000 total lines.
- `patch` and `before` or `after` together are rejected.

## Output details contract

The tool returns structured metadata under `details`.

Shared fields for modes that create a viewer:

- `artifactId`
- `viewerUrl`
- `viewerPath`
- `title`
- `expiresAt`
- `inputKind`
- `fileCount`
- `mode`

Image fields when PNG is rendered:

- `imagePath`
- `path` (same value as `imagePath`, for message tool compatibility)
- `imageBytes`

Mode behavior summary:

- `mode: "view"`: viewer fields only.
- `mode: "image"`: image fields only, no viewer artifact.
- `mode: "both"`: viewer fields plus image fields. If screenshot fails, viewer still returns with `imageError`.

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
- `mode`

Explicit tool parameters override these defaults.

## Security config

- `security.allowRemoteViewer` (`boolean`, default `false`)
  - `false`: non-loopback requests to viewer routes are denied.
  - `true`: remote viewers are allowed if tokenized path is valid.

Example:

```json5
{
  plugins: {
    entries: {
      diffs: {
        enabled: true,
        config: {
          security: {
            allowRemoteViewer: false,
          },
        },
      },
    },
  },
}
```

## Artifact lifecycle and storage

- Artifacts are stored under the temp subfolder: `$TMPDIR/openclaw-diffs`.
- Viewer artifact metadata contains:
  - random artifact ID (20 hex chars)
  - random token (48 hex chars)
  - `createdAt` and `expiresAt`
  - stored `viewer.html` path
- Default viewer TTL is 30 minutes when not specified.
- Maximum accepted viewer TTL is 6 hours.
- Cleanup runs opportunistically after artifact creation.
- Expired artifacts are deleted.
- Fallback cleanup removes stale folders older than 24 hours when metadata is missing.

## Viewer URL and network behavior

Viewer route:

- `/plugins/diffs/view/{artifactId}/{token}`

Viewer assets:

- `/plugins/diffs/assets/viewer.js`
- `/plugins/diffs/assets/viewer-runtime.js`

URL construction behavior:

- If `baseUrl` is provided, it is used after strict validation.
- Without `baseUrl`, viewer URL defaults to loopback `127.0.0.1`.
- If gateway bind mode is `custom` and `gateway.customBindHost` is set, that host is used.

`baseUrl` rules:

- Must be `http://` or `https://`.
- Query and hash are rejected.
- Origin plus optional base path is allowed.

## Security model

Viewer hardening:

- Loopback-only by default.
- Tokenized viewer paths with strict ID and token validation.
- Viewer response CSP:
  - `default-src 'none'`
  - scripts and assets only from self
  - no outbound `connect-src`
- Remote miss throttling when remote access is enabled:
  - 40 failures per 60 seconds
  - 60 second lockout (`429 Too Many Requests`)

Image rendering hardening:

- Screenshot browser request routing is deny-by-default.
- Only local viewer assets from `http://127.0.0.1/plugins/diffs/assets/*` are allowed.
- External network requests are blocked.

## Browser requirements for image mode

`mode: "image"` and `mode: "both"` need a Chromium-compatible browser.

Resolution order:

1. `browser.executablePath` in OpenClaw config.
2. Environment variables:
   - `OPENCLAW_BROWSER_EXECUTABLE_PATH`
   - `BROWSER_EXECUTABLE_PATH`
   - `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`
3. Platform command/path discovery fallback.

Common failure text:

- `Diff image rendering requires a Chromium-compatible browser...`

Fix by installing Chrome, Chromium, Edge, or Brave, or setting one of the executable path options above.

## Troubleshooting

Input validation errors:

- `Provide patch or both before and after text.`
  - Include both `before` and `after`, or provide `patch`.
- `Provide either patch or before/after input, not both.`
  - Do not mix input modes.
- `Invalid baseUrl: ...`
  - Use `http(s)` origin with optional path, no query/hash.
- `{field} exceeds maximum size (...)`
  - Reduce payload size.
- Large patch rejection
  - Reduce patch file count or total lines.

Viewer accessibility issues:

- Viewer URL resolves to `127.0.0.1` by default.
- For remote access scenarios, either:
  - pass `baseUrl` per tool call, or
  - use `gateway.bind=custom` and `gateway.customBindHost`
- Enable `security.allowRemoteViewer` only when you intend external viewer access.

Artifact not found:

- Artifact expired due TTL.
- Token or path changed.
- Cleanup removed stale data.

## Operational guidance

- Prefer `mode: "view"` for local interactive reviews in canvas.
- Prefer `mode: "image"` for outbound chat channels that need an attachment.
- Keep `allowRemoteViewer` disabled unless your deployment requires remote viewer URLs.
- Set explicit short `ttlSeconds` for sensitive diffs.
- Avoid sending secrets in diff input when not required.

Diff rendering engine:

- Powered by [Diffs](https://diffs.com).

## Related docs

- [Tools overview](/tools)
- [Plugins](/tools/plugin)
- [Browser](/tools/browser)
