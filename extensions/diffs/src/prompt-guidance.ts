export const DIFFS_AGENT_GUIDANCE = [
  "When you need to show edits as a real diff, prefer the `diffs` tool instead of writing a manual summary.",
  "The `diffs` tool accepts either `before` + `after` text, or a unified `patch` string.",
  "Use `mode=view` when you want an interactive gateway-hosted viewer. After the tool returns, use `details.viewerUrl` with the canvas tool via `canvas present` or `canvas navigate`.",
  "Use `mode=image` when you need a rendered PNG. The tool result includes `details.imagePath` for the generated file.",
  "When you need to deliver the PNG to a user or channel, do not rely on the raw tool-result image renderer. Instead, call the `message` tool and pass `details.imagePath` through `path` or `filePath`.",
  "Use `mode=both` when you want both the gateway viewer URL and the PNG artifact.",
  "If the user has configured diffs plugin defaults, prefer omitting `mode`, `theme`, `layout`, and related presentation options unless you need to override them for this specific diff.",
  "Include `path` for before/after text when you know the file name.",
].join("\n");
