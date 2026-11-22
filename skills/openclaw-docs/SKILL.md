---
name: openclaw-docs
description: "Find the OpenClaw docs page for a topic from a map of every docs page."
---

# OpenClaw docs

1. Find the docs root, `<docs>`, on the `Docs:` line of your Documentation prompt section. Page `x/y` is `<docs>/x/y.md` locally and `https://docs.openclaw.ai/x/y` on the web. Drop a trailing `/index` on the web.
2. Search [docs-map.md](references/docs-map.md) for your terms. If you cannot search files, read it whole. It lists every docs page by navigation tab and group. `dir/{a,b}` means `dir/a` and `dir/b`. Open a page marked (web only) on the web.
3. If the map has no match, search the `summary:` frontmatter lines of the local docs pages.
4. If you still have no match and have a shell with network access, run `openclaw docs <query>`. It searches the live docs.
5. Read the page before you answer.
