---
summary: "Native browser annotation SDK and compatibility with page annotation integrations"
title: "Browser annotations"
read_when:
  - Your plugin serves an interactive canvas or game preview
  - You want existing page annotation integrations to work in OpenClaw
---

Plugins can describe selectable objects inside a canvas without implementing a
chat transport. OpenClaw owns selection, preview controls, screenshot capture,
and adding an annotation to the current chat composer. The user sends the message.

This capability is independent of the agent provider. Native pages use
`document.openclaw.annotation`; the browser plugin also adapts the supported
`document.oai.annotation` methods for existing integrations. No Codex inference
session or modifications to the existing plugin package are required.

## Register a surface

Types are available from `openclaw/plugin-sdk/browser-annotations`. The page API
is optional: keep the ordinary preview working when it is absent.

```ts
import type { BrowserAnnotationApi } from "openclaw/plugin-sdk/browser-annotations";

const api = (
  document as Document & {
    openclaw?: { annotation?: BrowserAnnotationApi<Element> };
  }
).openclaw?.annotation;

const surface = api?.registerSurface({
  element: canvas,
  hitTest({ clientX, clientY, signal }) {
    if (signal.aborted) return null;
    const object = pickObject(clientX, clientY);
    return (
      object && {
        id: object.id,
        name: object.name,
        role: "game-sprite",
        rect: object.viewportRect,
        metadata: { frame: capturedFrame, tile: object.tile },
      }
    );
  },
  renderSelection({ selectedId, hoveredId }) {
    drawSelection(selectedId, hoveredId);
  },
});

annotateButton.onclick = () => api?.toggle(true);
```

Coordinates and rectangles use viewport CSS pixels. Target IDs belong to a
surface and its current capture. Call `surface.invalidate()` when that capture
changes, and `surface.dispose()` when the surface is removed. Invalidation
cancels pending hit tests and clears the selected target. Dispose control
registrations with their page component as well.

`toggle` and `request` return `{ accepted: boolean }` synchronously. Acceptance
means annotation mode changed, **not** that a message was sent. Entry requires
user activation. `isActive()` reports the current mode; the document emits
`openclawannotationmodechange` with `{ active }`. A page can freeze a capture
on entry and resume playback on exit.

## Preview controls

`registerControls({ targets: canvas, controls, controlsHeading })` returns
`update(...)` and `dispose()`. This version supports up to four `color` controls
with a `callback` identifier, optional `label`, and `currentValue` in `#rrggbb`
format. The target element receives `openclawannotationcontrolchange` events:

```ts
canvas.addEventListener("openclawannotationcontrolchange", (event) => {
  // detail: { action, callback, value, virtualTarget: { surfaceId, targetId } }
  // action: "preview", "preview-original", or "reset"
  updateTemporaryPreview((event as CustomEvent).detail);
});
```

Preview changes are page-owned and temporary. This API does not grant file,
device, tool, credential, or message-send access. Target metadata is bounded JSON
and reaches the agent explicitly labeled as untrusted page data.

## Compatibility and limits

The compatibility adapter translates surface registration, selection rendering,
color controls, mode queries, `toggle`, `request`, and the matching `oaiannotation*`
events. It does not replace an existing `document.oai.annotation` implementation.
This is not a general implementation of ChatGPT's browser APIs or `window.openai`.

The initial host is the managed Chromium browser panel with browser evaluation
enabled. Session dashboards install the API before their first navigation;
attaching an existing managed tab installs it for the current document and future
reloads. Pages that check once before attachment must reload or retry discovery.
The panel refreshes its projection after user input; there is no background polling.
Native embedded Mac browser and existing-session profiles are not supported by
this API yet and retain their ordinary browsing/annotation behavior.

Selections are scoped to their document. Navigation and invalidation reject stale
controls. Adding to chat captures fresh preview pixels and verifies that the
document and selection still match. Chat attachment limits still apply; rejected
attachments remain retryable. Annotations use the existing composer cards, not a
new persistent annotation store.

Other host contracts—MCP App display modes, file bridges, audio transport, and
`window.openai`—are separate capabilities. Existing plugins can use each supported
contract without adopting a Codex-specific OpenClaw runtime.
