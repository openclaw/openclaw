---
title: "Docs Viewer Implementation Guide"
description: "Reusable reference for replicating the operator1 docs sidebar/viewer in other projects"
dartboard: "Operator1/Tasks"
type: Project
status: "Done"
priority: low
assignee: "rohit sharma"
tags: [reference, ui, docs]
startAt: "2026-03-19"
dueAt: "2026-03-19"
---

# Docs Viewer Implementation Guide

**Created:** 2026-03-19
**Status:** Done (reference document)
**Depends on:** None

---

## 1. Overview

Documents how the operator1 in-app documentation viewer works end-to-end — sidebar navigation, full-text search, markdown rendering, and table of contents. Written as a replication guide for use in other projects.

---

## 2. Core Packages

| Package            | Version    | Role                                                                                                                             |
| ------------------ | ---------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `fumadocs-core`    | `^16.6.14` | Page tree builder + source loader (slug mapping, page listing). Used as a pure data tool — no Next.js or fumadocs UI components. |
| `react-markdown`   | `^10.1.0`  | Markdown-to-React rendering with fully custom element overrides                                                                  |
| `remark-gfm`       | `^4.0.1`   | GFM plugin (tables, task lists, strikethrough)                                                                                   |
| `marked`           | `^17.0.1`  | Lexer only — splits markdown into token blocks for memoized per-block rendering                                                  |
| `shiki`            | `^3.22.0`  | Syntax highlighting for code blocks via `codeToHtml()`                                                                           |
| `fuse.js`          | (in deps)  | Client-side fuzzy search over page titles + content                                                                              |
| `react-router-dom` | (core dep) | Routing, `NavLink` for active-state sidebar highlighting                                                                         |

---

## 3. Architecture Overview

The system is **entirely client-side with build-time bundling** — no backend RPC serves docs content.

```
MD files on disk
  --> Vite eager glob import (?raw strings)
    --> fumadocs-core loader() builds page tree + flat page list
      --> Sidebar renders tree, Fuse.js indexes pages
        --> react-markdown renders selected page with custom components
          --> Shiki highlights code blocks
          --> IntersectionObserver tracks TOC scroll position
```

---

## 4. Content Pipeline

### 4.1 Build Step (pre-Vite)

`scripts/update-docs-timestamps.mjs` walks doc files and stamps `updated: "YYYY-MM-DD"` into frontmatter. Also generates `ui-next/src/lib/docs-dates.generated.json` (slug-to-date map).

### 4.2 Vite Glob Import

```ts
const rawDocs = import.meta.glob("../../../docs/operator1/*.md", {
  eager: true,
  query: "?raw",
  import: "default",
});
```

All `.md` files are bundled as raw strings at build time. No runtime fetch.

### 4.3 fumadocs-core Loader

Raw strings are assembled into virtual file objects (`{ type: "page", path, data }`) and passed to `loader()` from `fumadocs-core/source`, which produces:

- `getPages()` — flat list for prev/next navigation and Fuse.js indexing
- `getPage(slugs)` — single page lookup by slug array
- `pageTree` — hierarchical tree for the sidebar

Before storage, each doc goes through:

1. `extractTitle()` / `extractDescription()` / `extractUpdated()` — parse frontmatter via regex
2. `stripFrontmatter()` — remove the `---` block
3. `rewriteOperator1Links()` or `sanitizeMintlifyContent()` — rewrite internal links for SPA routing

---

## 5. Sidebar

Driven by `fumadocs-core`'s `pageTree` (tree of `folder` and `page` nodes). Features:

- **Collapsible folders** — auto-expand when child page is active or search query is typed
- **Section number prefixes** — computed by `buildSectionNumbers()` (e.g., "2.3")
- **Active page highlighting** — via `NavLink` from react-router-dom
- **Inline search** — replaces tree with Fuse.js results when query is present
- **Mobile overlay** — hamburger toggle, hidden on `lg:` breakpoint and above
- **Category ordering** — controlled by `CATEGORY_ORDER` / `FOLDER_META` arrays in content files

---

## 6. Search

Two search surfaces, both powered by **Fuse.js** (client-side fuzzy search):

```ts
const fuse = new Fuse(allPages, {
  keys: [
    { name: "data.title", weight: 3 },
    { name: "data.content", weight: 1 },
  ],
  threshold: 0.6,
  includeMatches: true,
  ignoreLocation: true,
});
```

1. **Sidebar inline search** — plain `<Input>` that replaces page tree with results (title + content snippet)
2. **Cmd+K modal** (`DocsSearchModal`) — full-screen modal with keyboard navigation (ArrowUp/Down, Enter, Escape), shows up to 8 results

After navigation, a DOM-based highlighter (`useContentHighlight`) walks text nodes and wraps matches in `<mark>` elements.

---

## 7. Markdown Rendering

The `Markdown` component (`ui-next/src/components/ui/custom/prompt/markdown.tsx`) uses `react-markdown` with **fully custom element overrides** — every HTML element (`h1`-`h4`, `a`, `code`, `pre`, `table`, `img`, `blockquote`, `ul`, `ol`, `p`, `strong`, `hr`) is replaced with a Tailwind-styled component.

- `marked.lexer()` splits markdown into token blocks for **memoized per-block rendering** (streaming performance optimization)
- Code blocks use `shiki`'s `codeToHtml()` for syntax highlighting (`ui-next/src/components/ui/custom/prompt/code-block.tsx`)

---

## 8. Table of Contents (Right Sidebar)

`DocsToc` component (`ui-next/src/components/docs/docs-toc.tsx`):

- Parses H2/H3 headings from raw markdown using line-by-line regex (no remark parsing)
- Computes section numbers (e.g., "2.", "2.1")
- Uses `IntersectionObserver` to highlight active heading on scroll
- Clicking a TOC item smooth-scrolls to the heading's DOM `id` (assigned via `slugifyHeading()`)
- Hidden below `xl:` breakpoint

---

## 9. Routing

React Router v6 with wildcard patterns (registered in `ui-next/src/app.tsx`):

```
/docs         -> DocsPage
/docs/*       -> DocsPage
/openclaw-docs    -> OpenClawDocsPage
/openclaw-docs/*  -> OpenClawDocsPage
```

Both pages are lazy-loaded (`React.lazy` + `Suspense`). Inside `DocsPage`, `useParams<{ "*": string }>()` extracts the slug, which is split on `/` and passed to `getPage(slugs)`.

The `DocsPage` component accepts an optional `source` prop (`DocsSource` interface), making it fully reusable:

```ts
<DocsPage source={openclawSource} />
```

---

## 10. Multiple Doc Sets

The design supports multiple independent doc sets via injectable `DocsSource`:

| Route              | Source File                | MD Source Path                              |
| ------------------ | -------------------------- | ------------------------------------------- |
| `/docs/*`          | `docs-content.ts`          | `docs/operator1/*.md` (flat, curated order) |
| `/openclaw-docs/*` | `docs-openclaw-content.ts` | `docs/**/*.md` (recursive, auto-organized)  |

The openclaw source runs `sanitizeMintlifyContent()` — a regex preprocessor that converts Mintlify JSX (`<Card>`, `<Steps>`, `<Tip>`, `<Accordion>`, `<Tabs>`) into standard markdown before rendering.

---

## 11. Key Files

**Pages:**

- `ui-next/src/pages/docs.tsx` — main DocsPage (sidebar, search modal, highlight logic)
- `ui-next/src/pages/openclaw-docs.tsx` — thin wrapper passing openclaw source

**Content/data layer:**

- `ui-next/src/lib/docs-content.ts` — operator1 docs: glob import, fumadocs loader, category ordering
- `ui-next/src/lib/docs-openclaw-content.ts` — openclaw docs: glob import, Mintlify sanitizer, fumadocs loader
- `ui-next/src/lib/docs-dates.generated.json` — build-time slug-to-date map

**Components:**

- `ui-next/src/components/docs/docs-toc.tsx` — right-column TOC with IntersectionObserver
- `ui-next/src/components/docs/docs-pagination.tsx` — prev/next page navigation
- `ui-next/src/components/ui/custom/prompt/markdown.tsx` — Markdown renderer
- `ui-next/src/components/ui/custom/prompt/code-block.tsx` — Shiki code block
- `ui-next/src/components/ui/highlight-text.tsx` — inline keyword highlighting

**Routing:**

- `ui-next/src/app.tsx` — route registrations

**Sidebar entry:**

- `ui-next/src/components/app-sidebar.tsx` — nav entries for docs sections

**Build tooling:**

- `scripts/update-docs-timestamps.mjs` — pre-build frontmatter stamper

---

## 12. Minimal Replication Steps

To replicate in a fresh Vite + React + React Router project:

1. `npm install fumadocs-core react-markdown remark-gfm marked shiki fuse.js`
2. Use `import.meta.glob(".../*.md", { eager: true, query: "?raw", import: "default" })` to bundle MD files as strings
3. Build virtual file objects and pass to `loader()` from `fumadocs-core/source` to get `getPages()`, `getPage()`, and `pageTree`
4. Render `pageTree` as a collapsible sidebar; use `NavLink` for active-state highlighting
5. Build a `Fuse` index from `getPages()` for search (title weight 3, content weight 1)
6. Render page content with `<ReactMarkdown remarkPlugins={[remarkGfm]}>` and custom element overrides
7. Use `codeToHtml()` from `shiki` inside the custom `code` component
8. Parse H2/H3 from raw markdown for TOC; use `IntersectionObserver` for scroll tracking
9. Register wildcard routes (`/docs` + `/docs/*`); extract slug from `useParams<{ "*": string }>()`
10. For multiple doc sets, parameterize the `DocsPage` with a `source` prop

---

## 7. References

- Key source files listed in section 11 above
- fumadocs-core docs: https://fumadocs.vercel.app
- react-markdown: https://github.com/remarkjs/react-markdown
- Fuse.js: https://www.fusejs.io
