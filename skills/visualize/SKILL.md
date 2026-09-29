---
name: visualize
description: "Create inline visuals for code and explanations, or author persistent OpenClaw dashboard widgets with show_widget."
---

# Visualize

Use `show_widget` when seeing or interacting with a result helps the user reason
about it. This includes code architecture, execution traces, performance,
comparisons, simulations, UI mockups, and session dashboards. Use prose, a normal
Markdown table, or a supported Mermaid block when that already explains the
answer. A request to implement an application still needs changes in its project;
a widget can illustrate the design but does not complete the implementation.

## Choose the surface

- **Code work and one-off explanations:** prefer inline when available this turn.
  Show the actual owners, relationships, measured values, or states relevant to the question.
  Distinguish proposed designs and illustrative data from observed behavior.
  Several diagrams for a code task do not by themselves call for a dashboard.
- **Persistent dashboards:** use `pin: true` for an explicit dashboard request
  or multiple non-code visualizations that belong together. Read the current
  board first and reuse its names and tabs. Use the `control-ui` skill when
  organizing sessions, tabs, placement, or dashboard presentation.
- **Native reports:** prefer the tool's `report` input with `pin: true` for
  dashboard text, metrics, tables, simple charts, and links. Omit `widget_code`,
  `kind`, `capabilities`, and `presentation.target`. Reports do not render inline.
- **Custom widgets:** use `widget_code` for interactive HTML/SVG. Reuse an
  explicit `name` with `pin: true` to replace a pinned widget's content. A same-name
  update cannot change its content owner; inspect before converting HTML to a report.

Use only tools, source kinds, and presentation targets advertised in this turn.
On a pinned-only surface, set `pin: true` and omit `presentation.target`. If the
tool is unavailable, explain the limitation instead of inventing a render call.
Restart recovery can be pinned-only even when the original turn supported inline
widgets; follow the current tool schema instead of earlier delivery instructions.

## Author the content

Send the markup itself in `widget_code`. Use an HTML or SVG fragment, optionally
including `<style>` and `<script>`; OpenClaw supplies the document shell, theme,
and host bridges. Do not send a file path, Markdown fence, full HTML document, or
another application's visualization directive. `title` is host metadata: start
with useful content rather than repeating the title or drawing dashboard chrome.

Keep a useful initial state in the markup. Use local JavaScript for selections,
filters, parameter changes, and animation. Give the root a unique ID and scope
styles and selectors to it. Insert labels and external data with `textContent`
instead of interpolating untrusted strings into markup or executable code.

Keep source compact: `widget_code` is limited to 262,144 characters, pinned HTML
to 256 KiB after wrapping, and Discord source to 48 KiB. Aggregate large datasets
and load a suitable library instead of embedding its distribution in the call.

## Libraries and fonts

Scripts, ES modules, stylesheets, and fonts can load from these HTTPS origins:

- `https://cdnjs.cloudflare.com`
- `https://cdn.jsdelivr.net`
- `https://esm.sh`
- `https://unpkg.com`
- `https://fonts.googleapis.com`
- `https://fonts.gstatic.com`
- `https://fonts.bunny.net`

Use version-pinned library URLs. For example, load D3 with
`<script src="https://cdn.jsdelivr.net/npm/d3@7.9.0/dist/d3.min.js" crossorigin="anonymous"></script>`
before the inline script that uses `d3`. Use a module script for ESM imports.
Transitive imports, font files, and redirects must also stay on allowed origins.
No library, icon set, or font is preloaded. Choose native SVG/CSS for simple
visuals; load a library when its scales, layout, or interaction justify it.

Provide readable fallback content and a visible failure state if an asset fails
to load. Avoid eval-based libraries; `unsafe-eval`, remote frames, and arbitrary
resource hosts remain unavailable. Images must be embedded as data URLs or drawn
locally. CDN URLs are for public assets, never private data or credentials.

CDN loading does not grant `fetch`, WebSocket, or host API access. Retrieve data
with the agent's available tools and embed the needed observations for inline
visuals. Use dashboard capabilities for refreshable data, as described below.

## Composition and theme

For code explanations, emphasize the relationship being discussed: aligned lanes
for concurrent work, labeled edges for ownership and data flow, or shared scales
for performance comparisons. Keep source details that support the conclusion;
avoid decorative metrics or diagrams of unrelated modules.

For dashboards, make each widget useful on its own and keep related measures
comparable. Show data freshness, units, loading, empty, and error states where
they affect interpretation. Preserve the last successful data when refresh fails.
Use a mockup's product context for its inner controls while retaining the host's
theme for the surrounding surface.

OpenClaw styles native headings, controls, tables, and code. It provides `.card`,
`.row`, `.metric`, `.muted`, `.badge` with `.ok`/`.warn`/`.danger`/`.info`, and
`button.primary`. Use these when they fit; do not assume another host's classes.
Colors and typography use `--text`, `--text-strong`, `--muted`, `--surface`,
`--card`, `--elevated`, `--border`, `--border-strong`, `--accent`, `--accent-fill`,
`--accent-fg`, `--ok`, `--warn`, `--danger`, `--info`, `--radius`, `--font-body`,
and `--font-mono`. Keep the outer background transparent and avoid extra cards
around a whole plot. Pair colors with labels or shapes. Canvas libraries need
resolved computed colors and redraws when the host theme changes.

Fit the actual container, including narrow chat and resized dashboard columns.
Use fluid widths, wrapping controls, and stacked panels; reserve horizontal
scrolling for code, tables, or diagrams that require exact geometry. Size SVGs
from their container and keep labels readable instead of shrinking a desktop
layout. Include axes and units for plots, accessible names, visible control
labels, keyboard operation, and touch targets. Honor reduced-motion preferences.

## Conversation and dashboard actions

Keep presentation-only changes local. A clearly labeled user-clicked control can
call `openclaw.prompt.send(text)` to ask the agent to investigate selected values.
Include those values and the requested action. In the Control UI, prompts need a
real user activation in the visible, focused widget; text must be nonempty, at
most 4,000 characters, and cannot start with `/`. Do not trigger prompts on load
or on every filter change, and do not assume the widget can read the agent reply.
Native renderers do not provide the Control UI conversation bridge.

Only pinned dashboard widgets have the ticket-bound data and action APIs:

- `openclaw.data.read(bindingId, params?)` reads an advertised Gateway binding.
- `openclaw.action.run(actionId, params?)` invokes an advertised action.
- `openclaw.cron.trigger(jobId)` requires `cron.trigger:<jobId>`.
- `openclaw.state.emit(payload)` emits a bounded session notice.

Use the current tool schema for binding/action IDs and their parameter shapes.
Declare required grants in `capabilities.tools`. For browser API fetches, declare
exact HTTPS origins in `capabilities.netOrigins`; the browser still requires
CORS. Use host bindings for authenticated data; never embed tokens in HTML.
Inline previews do not inherit dashboard grants. Check `capabilityState` and
report pending or rejected access; saving a widget does not prove a data read.
Updated content may require approval again.

Use normal dashboard links with `target="_blank" rel="noopener noreferrer"`.
`window.open` and nested external iframes do not work. For Control UI links,
read `openclaw.host.controlUiBaseUrl` at click time; it is null before dashboard
initialization and outside that host.

## Verify and deliver

Fix reported inline-script syntax errors and call the tool again. Inspect the
rendered result with available browser or device tools: verify libraries and
fonts loaded, important controls work, and content fits the intended width and
theme. For live dashboards, exercise the data read in the actual pinned frame.
Strict embed mode disables scripts. Report any concrete visual or platform
verification gap; successful hosting alone proves neither rendering nor data access.

Follow `result.presentation` when present. A `status: "pinned"` result means the
widget is on the session dashboard. Use the available dashboard tool to focus its
tab in the current session. Do not navigate to widget hosting URLs in the Browser
panel as a substitute for presentation.

Keep the final prose focused on the useful conclusion or remaining limitation,
without repeating the entire visual. Do not promise PNG exports preserve externally
loaded styles or fonts without checking the exported image.
