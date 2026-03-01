# @openclaw/diffs

Read-only diff viewer plugin for **OpenClaw** agents.

It gives agents one tool, `diffs`, that can:

- render a gateway-hosted diff viewer for canvas use
- render the same diff to a PNG image
- accept either arbitrary `before`/`after` text or a unified patch

## What Agents Get

The tool can return:

- `details.viewerUrl`: a gateway URL that can be opened in the canvas
- `details.imagePath`: a local PNG artifact when image rendering is requested

This means an agent can:

- call `diffs` with `mode=view`, then pass `details.viewerUrl` to `canvas present`
- call `diffs` with `mode=image`, then send the PNG through the normal `message` tool using `path` or `filePath`
- call `diffs` with `mode=both` when it wants both outputs

## Tool Inputs

Before/after:

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

Useful options:

- `mode`: `view`, `image`, or `both`
- `layout`: `unified` or `split`
- `theme`: `light` or `dark` (default: `dark`)
- `expandUnchanged`: expand unchanged sections
- `path`: display name for before/after input
- `title`: explicit viewer title
- `ttlSeconds`: artifact lifetime
- `baseUrl`: override the gateway base URL used in the returned viewer link

## Plugin Defaults

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

Explicit tool parameters still win over these defaults.

## Example Agent Prompts

Open in canvas:

```text
Use the `diffs` tool in `view` mode for this before/after content, then open the returned viewer URL in the canvas.

Path: docs/example.md

Before:
# Hello

This is version one.

After:
# Hello

This is version two.
```

Render a PNG:

```text
Use the `diffs` tool in `image` mode for this before/after input. After it returns `details.imagePath`, use the `message` tool with `path` or `filePath` to send me the rendered diff image.

Path: README.md

Before:
OpenClaw supports plugins.

After:
OpenClaw supports plugins and hosted diff views.
```

Do both:

```text
Use the `diffs` tool in `both` mode for this diff. Open the viewer in the canvas and then send the rendered PNG by passing `details.imagePath` to the `message` tool.

Path: src/demo.ts

Before:
const status = "old";

After:
const status = "new";
```

Patch input:

```text
Use the `diffs` tool with this unified patch in `view` mode. After it returns the viewer URL, present it in the canvas.

diff --git a/src/example.ts b/src/example.ts
--- a/src/example.ts
+++ b/src/example.ts
@@ -1,3 +1,3 @@
 export function add(a: number, b: number) {
-  return a + b;
+  return a + b + 1;
 }
```

## Notes

- The viewer is hosted locally through the gateway under `/plugins/diffs/...`.
- Artifacts are ephemeral and stored in the local temp directory.
- PNG rendering requires a Chromium-compatible browser. Set `browser.executablePath` if auto-detection is not enough.
- Diff rendering is powered by [Diffs](https://diffs.com).
