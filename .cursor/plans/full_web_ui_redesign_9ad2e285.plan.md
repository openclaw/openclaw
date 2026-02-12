---
name: Full Web UI Redesign
overview: "Complete redesign of the OpenClaw web app (apps/web/) to match the Dench design system: switch from dark theme to light, adopt Instrument Serif + Inter fonts, port the Dench color palette and layout patterns, and rewrite every component and page from the ground up."
todos:
  - id: foundation
    content: "Phase 1: Rewrite globals.css (light theme, HSL tokens, font imports) and layout.tsx (next/font, remove dark mode)"
    status: pending
  - id: landing
    content: "Phase 2: Rewrite app/page.tsx as Dench-style landing page (navbar, hero, demo sections, footer)"
    status: pending
  - id: layout-shell
    content: "Phase 3: Create app-navbar.tsx, rewrite workspace/page.tsx layout with top navbar + sidebar grid"
    status: pending
  - id: sidebar
    content: "Phase 4: Redesign workspace-sidebar.tsx and file-manager-tree.tsx to match Dench sidebar"
    status: pending
  - id: data-table
    content: "Phase 5: Redesign object-table.tsx with Dench-style toolbar, sticky headers, pagination, enum badges"
    status: pending
  - id: kanban
    content: "Phase 6: Redesign object-kanban.tsx with light cards, columns, board header"
    status: pending
  - id: entry-detail
    content: "Phase 7: Redesign entry-detail-modal.tsx as right-panel slide-out with properties list"
    status: pending
  - id: dashboard-chat
    content: "Phase 8a: Build dashboard view with greeting, centered chat input, suggestion chips, and animate-down-to-bottom Framer Motion layoutId transition"
    status: pending
  - id: chat
    content: "Phase 8b: Restyle chat-panel.tsx, chat-message.tsx, chain-of-thought.tsx for light theme + bottom composer"
    status: pending
  - id: remaining
    content: "Phase 9: Restyle all remaining components (breadcrumbs, document-view, file-viewer, database-viewer, empty-state, markdown, context-menu, slash-command, charts, etc.)"
    status: pending
  - id: deps
    content: "Phase 10: Add framer-motion dependency, verify fonts work, test build"
    status: pending
isProject: false
---

# Full Web UI Redesign — Dench Design System

## Current State

The OpenClaw web app is a **dark-themed** Next.js 15 app with:

- Dark background (`#0a0a0a`), dark surfaces (`#141414`), orange accent (`#e85d3a`)
- Inter font only, no serif headings
- Minimal homepage (centered text + CTA)
- Workspace layout: left sidebar (260px) + content + optional chat panel
- Custom table/kanban/viewer components, all dark-styled
- Tailwind v4 (CSS-based config), no shadcn/ui

## Target State (Dench Design)

Per the screenshots and Dench source:

- **Light theme** — `bg-neutral-50` layout, white cards, `bg-neutral-100` sidebar/navbar
- **Instrument Serif** for headings/titles, **Inter** for body text, **Lora** for branding
- **Top navbar** (grid 3-col, with Dashboard/Workflows/Integrations tabs, org logo, user menu)
- **Left sidebar** (260px, `bg-neutral-100`, collapsible knowledge tree with item counts)
- **Data tables** with: sticky header, column borders, search bar, filter/column controls, enum badges, relation chips, pagination
- **Kanban board** with rounded cards, priority badges, assignee avatars
- **Entry detail** right-panel slide-out with property list
- **Landing page** with hero section, demo sections, clean navigation bar
- **Dashboard chat UX** — centered greeting ("Good evening, Kumar?") in Instrument Serif + centered chat input with suggestion chips; on first message, the input animates down to a bottom-docked composer via Framer Motion shared `layoutId` spring transition
- HSL-based CSS variables (shadcn pattern), `--radius: 0.5rem`, neutral base color

## Architecture Decision: Tailwind v4

The OpenClaw app uses **Tailwind v4** (CSS-based config via `@import "tailwindcss"`), while Dench uses Tailwind v3 (JS config). We will keep Tailwind v4 but port all design tokens into `globals.css` using `@theme` blocks and CSS custom properties. No downgrade needed.

## Architecture Decision: Light + Dark Theme

Dench is light-only. We will use Dench's light palette as the `:root` default AND create a custom dark palette under `.dark` (class-based toggle via `<html class="dark">`). All components will use CSS variable references (e.g. `bg-background`, `text-foreground`, `border-border`) so they automatically adapt. No hardcoded hex/rgb in components.

**Light palette** (from Dench):

- `--background: 0 0% 96%` (neutral-50 feel)
- `--foreground: 0 0% 3.9%`
- `--card: 0 0% 100%` / `--card-foreground: 0 0% 3.9%`
- `--muted: 0 0% 96.1%` / `--muted-foreground: 0 0% 45.1%`
- `--border: 0 0% 89.8%`
- `--primary: 0 0% 9%` / `--primary-foreground: 0 0% 98%`
- `--accent: 0 0% 96.1%` / `--accent-foreground: 0 0% 9%`
- `--destructive: 0 84.2% 60.2%`

**Dark palette** (custom, designed to complement Dench's light theme):

- `--background: 0 0% 7%` (#121212 — rich near-black, not pure black)
- `--foreground: 0 0% 93%` (#ededed)
- `--card: 0 0% 10%` (#1a1a1a) / `--card-foreground: 0 0% 93%`
- `--muted: 0 0% 14%` (#242424) / `--muted-foreground: 0 0% 55%` (#8c8c8c)
- `--border: 0 0% 18%` (#2e2e2e)
- `--primary: 0 0% 93%` / `--primary-foreground: 0 0% 9%`
- `--accent: 0 0% 16%` (#292929) / `--accent-foreground: 0 0% 93%`
- `--destructive: 0 62% 55%`
- Sidebar: `--sidebar-bg: 0 0% 9%` (#171717)
- Navbar: similar to sidebar, subtle `border-b` at `--border`

Sidebar/navbar in dark mode use a slightly elevated surface (`#171717`) rather than pure background, for depth.

**Theme toggle:** add a sun/moon toggle button in the navbar (right side, near user avatar). Use `next-themes` or a simple `useEffect` + `localStorage` approach to persist preference and apply `.dark` class on `<html>`.

---

## Files to Change

### Phase 1 — Foundation (Theme, Fonts, Layout Shell)

**[app/globals.css](apps/web/app/globals.css)** — Complete rewrite:

- `:root` block: Dench's light-theme HSL palette (background, foreground, card, primary, secondary, muted, accent, destructive, border, ring, sidebar, chart-1 through chart-5)
- `.dark` block: custom dark palette (see "Architecture Decision: Light + Dark Theme" above) — all same variable names, dark values
- Add `@theme` block for Tailwind v4 mapping CSS vars to utility classes (`bg-background`, `text-foreground`, `border-border`, `bg-card`, `text-muted-foreground`, etc.)
- Import Instrument Serif from Google Fonts
- Add `.font-instrument` utility class
- Port scrollbar, prose, editor, and slash-command styles using CSS variables (theme-aware, not hardcoded)
- Port workflow state colors (`--workflow-active`, `--workflow-processing`, `--workflow-idle`)

**[app/layout.tsx](apps/web/app/layout.tsx)** — Rewrite:

- Import Inter and Lora via `next/font/google`
- Set CSS variables `--font-corporate` and `--font-lora`
- Default to light: no `className="dark"` on `<html>` (let theme provider handle it)
- Apply `font-corporate` to `<body>`
- Add `suppressHydrationWarning` on `<html>` for theme flash prevention
- Add inline script or `next-themes` `ThemeProvider` for class-based dark mode toggle with `localStorage` persistence
- Update metadata title/description to "Dench" branding

**New: `app/hooks/use-theme.ts**` — Simple theme hook:

- Read/write `localStorage` key `"theme"` (`"light"` | `"dark"` | `"system"`)
- Apply/remove `.dark` class on `document.documentElement`
- Expose `theme`, `setTheme`, `resolvedTheme` for components

### Phase 2 — Landing Page

**[app/page.tsx](apps/web/app/page.tsx)** — Full rewrite to match Dench landing:

- Sticky navigation bar (logo "Dench" in `font-lora`, Login button in rounded-full blue pill)
- Hero section: "AI CRM" headline in `font-instrument font-bold`, subtext, "Get Started Free" CTA
- Full-width CRM demo area (window chrome with traffic-light dots, scaled mock table)
- Additional demo sections (workflow, kanban) — simplified versions
- Footer with copyright, links

### Phase 3 — Workspace Layout Shell

**[app/workspace/page.tsx](apps/web/app/workspace/page.tsx)** — Rewrite layout structure:

- Add top `AppNavbar` component: `bg-neutral-100 border-b border-border shadow-[0_0_40px_rgba(0,0,0,0.05)]`
  - Left: org logo + "Powered by Dench" + org name in `font-instrument`
  - Center: tab navigation (Dashboard, Workflows, Integrations) with active state
  - Right: credit display, notification bell, sun/moon theme toggle, user avatar dropdown
- Main area: `grid lg:grid-cols-[260px_1fr]` under navbar
- Full height: `h-[100dvh] flex flex-col bg-neutral-50`
- Content area: `overflow-y-auto overflow-x-hidden`
- Replace all inline `style={{}}` dark colors with Tailwind classes

**New component: `app/components/workspace/app-navbar.tsx**` — Top navbar (extracted for reuse)

### Phase 4 — Sidebar Redesign

**[app/components/workspace/workspace-sidebar.tsx](apps/web/app/components/workspace/workspace-sidebar.tsx)** — Full rewrite:

- Background: `bg-sidebar` with `border-r border-border` (light: neutral-100, dark: #171717 via CSS var)
- Shadow: theme-aware subtle shadow
- Header: "KNOWLEDGE" section label in uppercase `text-[11px] font-medium tracking-wider text-muted-foreground`
- Knowledge items: `text-[13px]`, hover `bg-accent`, `rounded-xl`
- Item badges showing entry counts in `bg-muted border border-border` pills
- Icons per item type (objects get custom icons, documents get doc icon)
- Collapsible sections: KNOWLEDGE, CHATS, TELEPHONY
- Bottom: "API Keys" link
- Remove all inline `style={{}}` dark colors

**[app/components/workspace/file-manager-tree.tsx](apps/web/app/components/workspace/file-manager-tree.tsx)** — Restyle tree items:

- Light-theme hover states, active states matching `bg-neutral-200`
- `text-[13px]` sizing, proper icon colors
- Drag-and-drop visual indicators in light theme

### Phase 5 — Data Table Redesign

**[app/components/workspace/object-table.tsx](apps/web/app/components/workspace/object-table.tsx)** — Complete rewrite to match Dench data-table:

- Toolbar: object name in `font-instrument`, search input (`rounded-full shadow-[0_0_21px_0_rgba(0,0,0,0.07)]`), "Ask AI" button, Table/Board view toggle, refresh/import/filter/columns/+ Add buttons
- Table header: `sticky top-0 z-30 bg-card border-b-2 border-border/80`, sortable columns with sort arrows
- Table cells: `px-4 border-r border-border/30`, proper text truncation
- Enum badges: colored pill style matching Dench (translucent background + border)
- Relation chips: link icon + blue text
- Row hover: `hover:bg-muted/50`
- Pagination bar: "Showing 1 to N of N results", rows-per-page selector, page navigation
- "..." action menu per row (right column)

### Phase 6 — Kanban Board Redesign

**[app/components/workspace/object-kanban.tsx](apps/web/app/components/workspace/object-kanban.tsx)** — Rewrite:

- Board header: view toggle (Board/Table), "Ask AI" button, search, "Group by" selector
- Columns: `bg-muted/50 rounded-2xl border border-border/60`, column title + count badge
- Cards: `bg-card rounded-xl border border-border/80 shadow-sm`
- Card content: title, field badges (objective, risk profile), date, assignee avatar
- "+ Add Item" at column bottom
- "Drop cards here" empty column placeholder

### Phase 7 — Entry Detail Panel

**[app/components/workspace/entry-detail-modal.tsx](apps/web/app/components/workspace/entry-detail-modal.tsx)** — Redesign as right-panel slide-out:

- Takes ~40% of content width, pushes table left
- Header: icon + title in large font, "Created Jan 12, 2026 at 12:47 PM" subtitle
- "PROPERTIES" section label
- Property rows: label (uppercase text-xs text-muted-foreground) + value
- Relation fields show colored link chips
- Enum fields show colored badges (matching table)
- "Add a property" at bottom
- Close button (>> icon) top-right

### Phase 8a — Dashboard Chat UX (Greeting + Animate-to-Bottom Input)

This is the hero interaction on the workspace "Dashboard" tab — a centered greeting with a chat input that transitions into the bottom-docked composer after the first message.

**How Dench implements it:**

- `DashboardHeader`: time-based greeting ("Good morning/afternoon/evening, Name?") with staggered word-by-word Framer Motion entrance (`y:20 → 0`, `blur(8px) → blur(0)`)
- `DashboardChatbox`: centered TipTap input with placeholder "Build a workflow to automate your tasks", attach/voice/submit buttons, suggestion chips below (shuffled from a pool of ~27 templates, showing 7 in two rows)
- **Layout animation:** both the centered input and the bottom composer share a Framer Motion `layoutId="chat-thread-composer"`. When `showStartComposer` flips to false after the first message, Framer Motion automatically animates the input from center to bottom with `transition={{ type: "spring", stiffness: 260, damping: 30 }}`

**New components to create:**

`app/components/workspace/dashboard-view.tsx` — Dashboard home view:

- Greeting in `font-instrument text-4xl` with time-based message + user name
- Word-by-word staggered Framer Motion entrance animation
- Centered chat input area below greeting

`app/components/workspace/dashboard-chatbox.tsx` — Centered input + chips:

- Rounded white card with subtle shadow, textarea/input with placeholder
- Attach (paperclip), voice (mic), submit (arrow) icon buttons
- Suggestion chip rows: 3 on first row, 4 on second row, each with icon + label + `rounded-xl` border
- Accepts `layoutId` prop for shared layout animation
- `mode` prop: `"dashboard"` (centered, with greeting) vs `"thread"` (same input but used within chat thread)
- Entry animation: `opacity: 0, y: 20` → `opacity: 1, y: 0`, duration 0.8s

**Modify [app/workspace/page.tsx](apps/web/app/workspace/page.tsx):**

- When no content selected (Dashboard tab active), render `DashboardView`
- On chat submit: transition to chat thread view
- Use `LayoutGroup` from Framer Motion to wrap the dashboard + chat area
- Track `showStartComposer` state: when true, show centered `DashboardChatbox`; when false, show messages + bottom `ChatComposer` — both sharing the same `layoutId`

**Prompt templates** (simplified set for OpenClaw):

- Follow-up Emails, Calendly Prep, Zoom Recap, Facebook Leads, Calendar Sync, Salesforce Sync, Intercom Chat (matching the Dench screenshot chips)

### Phase 8b — Chat & Message Restyling

**[app/components/chat-panel.tsx](apps/web/app/components/chat-panel.tsx)** — Restyle:

- Theme-aware background (`bg-card`), card-colored input area
- Input: rounded border, subtle shadow, consistent with dashboard chatbox style
- Bottom-docked composer with `layoutId` for shared animation
- Session tabs in light theme
- Tool call indicators in light theme
- Send button styling (rounded, neutral)

**[app/components/chat-message.tsx](apps/web/app/components/chat-message.tsx)** — Restyle:

- Theme-aware message bubbles (user: `bg-muted`, assistant: `bg-card`)
- Code blocks with `bg-muted`
- Markdown rendering in light theme
- Chain-of-thought styling update

**[app/components/chain-of-thought.tsx](apps/web/app/components/chain-of-thought.tsx)** — Light theme

### Phase 9 — Remaining Components

All components below: replace every hardcoded color (`style={{}}`, hex, rgb) with semantic Tailwind utilities (`bg-background`, `text-foreground`, `border-border`, `bg-card`, `text-muted-foreground`, `bg-muted`, etc.) so they work in both light and dark:

- **[breadcrumbs.tsx](apps/web/app/components/workspace/breadcrumbs.tsx)** — `text-muted-foreground`, `hover:text-foreground`
- **[document-view.tsx](apps/web/app/components/workspace/document-view.tsx)** — `bg-card` background, `border-border`
- **[file-viewer.tsx](apps/web/app/components/workspace/file-viewer.tsx)** — `bg-muted` code blocks, `text-foreground`
- **[database-viewer.tsx](apps/web/app/components/workspace/database-viewer.tsx)** — `bg-card` tables, `bg-muted` query editor
- **[empty-state.tsx](apps/web/app/components/workspace/empty-state.tsx)** — `text-muted-foreground` illustration
- **[markdown-content.tsx](apps/web/app/components/workspace/markdown-content.tsx)** — Prose styles via CSS vars
- **[markdown-editor.tsx](apps/web/app/components/workspace/markdown-editor.tsx)** — `bg-card` editor chrome
- **[context-menu.tsx](apps/web/app/components/workspace/context-menu.tsx)** — `bg-card` dropdown, `border-border`
- **[slash-command.tsx](apps/web/app/components/workspace/slash-command.tsx)** — `bg-card` command palette
- **[inline-rename.tsx](apps/web/app/components/workspace/inline-rename.tsx)** — `bg-card` input, `border-border`
- **[knowledge-tree.tsx](apps/web/app/components/workspace/knowledge-tree.tsx)** — Theme-aware tree styles
- **[charts/](apps/web/app/components/charts/)** — All chart components: CSS var chart colors, `bg-card` panels
- **[sidebar.tsx](apps/web/app/components/sidebar.tsx)** — Theme-aware (if still used)

### Phase 10 — Package Dependencies

**[package.json](apps/web/package.json)** — Add if needed:

- `framer-motion` (for landing page + dashboard chat animations)
- `next-themes` (for dark/light toggle with `localStorage` + class-based switching, SSR-safe)
- Verify `next/font/google` is available (bundled with Next.js)

---

## Key Design Tokens

- **Radius:** `0.5rem` base
- **Primary font:** Inter via `next/font/google`
- **Heading font:** Instrument Serif via Google Fonts import
- **Brand font:** Lora via `next/font/google`
- **Sidebar width:** 260px
- **Shadows (light):** `shadow-[0_0_40px_rgba(0,0,0,0.05)]` (sidebar/navbar), `shadow-[0_0_21px_0_rgba(0,0,0,0.07)]` (search)
- **Shadows (dark):** `shadow-[0_0_40px_rgba(0,0,0,0.2)]` (sidebar/navbar), `shadow-[0_0_21px_0_rgba(0,0,0,0.15)]` (search)

## Component Styling Rules (Theme-Safe)

All components MUST use semantic CSS variable-backed utilities — never hardcoded colors:

- `bg-background` / `bg-card` / `bg-muted` / `bg-accent` — not `bg-white`, `bg-neutral-50`, `bg-[#1a1a1a]`
- `text-foreground` / `text-muted-foreground` / `text-card-foreground` — not `text-black`, `text-gray-500`
- `border-border` — not `border-neutral-200`, `border-[#2e2e2e]`
- `bg-sidebar` for sidebar/navbar backgrounds
- For shadows that differ between themes: use a CSS variable `--shadow-subtle` / `--shadow-elevated` or conditional `dark:shadow-*` utilities
- Exceptions: Dench-specific decorative elements (landing page traffic-light dots, brand colors) can use fixed values
