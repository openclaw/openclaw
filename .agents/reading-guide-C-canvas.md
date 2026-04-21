# Reading Guide C: Live Canvas / A2UI

A one-session, bird's-eye map for the agent-driven visual workspace pipeline.
This is a MAP, not a walkthrough: open each file, skim, hold the questions,
move on. Goal: know where the TS host ends and the native client begins.

The pipeline, in the largest strokes:

```
agent output -> src/canvas-host/ (TS host, HTTP + WS + custom scheme assets)
             -> WKWebView inside apps/macos/ or apps/ios/ (native shell)
             -> A2UI bundle (src/canvas-host/a2ui/) renders inside the web view
```

## Stop 1 - Concept doc

- `docs/platforms/mac/canvas.md`
- Role: single source of truth for what Canvas/A2UI is on macOS.
- Takeaway in one line: an agent-controlled panel hosted in a `WKWebView`, fed
  by a custom `openclaw-canvas://` URL scheme and served from per-session
  directories under Application Support.
- What to look for:
  - Which URLs map to which on-disk layout?
  - What is served by the TS host vs by the native scheme handler?
  - Where does A2UI enter the story (it is only one of several content types)?

## Stop 2 - The generated A2UI bundle area

- `src/canvas-host/a2ui/`
- Role: shipped, pre-built A2UI renderer loaded into the web view.
- Files present: `a2ui.bundle.js`, `index.html`, `.bundle.hash` (generated;
  AGENTS.md: produced by `pnpm canvas:a2ui:bundle`, committed separately).
- What to look for:
  - Treat the whole directory as a build artifact; do not read the bundle.
  - Note that `index.html` is the entry the web view actually loads.
  - Remember the hash gate exists so CI can detect drift.

## Stop 3 - The host pipeline

- `src/canvas-host/server.ts` - HTTP + WebSocket server (`/__openclaw__/a2ui`,
  `/__openclaw__/canvas`, `/__openclaw__/ws`). Main agent <-> client seam.
- `src/canvas-host/a2ui.ts` - resolves and serves the A2UI bundle root; owns
  the `A2UI_PATH` / `CANVAS_HOST_PATH` / `CANVAS_WS_PATH` constants.
- `src/canvas-host/file-resolver.ts` - safe path resolution under a session
  root; the sandbox boundary for served files.
- What to look for:
  - Which path prefixes are HTTP, which are upgraded to WS?
  - Where is the per-session root derived, and who writes into it?
  - What stops a session from escaping its directory?

## Stop 4 - macOS native receiver

- `apps/macos/Sources/OpenClaw/CanvasWindowController.swift` and siblings
  (`CanvasManager.swift`, `CanvasScheme.swift`, `CanvasSchemeHandler.swift`,
  `CanvasFileWatcher.swift`, `CanvasA2UIActionMessageHandler.swift`,
  `CanvasWindow.swift`, `CanvasChromeContainerView.swift`).
- Role: native shell hosting `WKWebView`, resolving the custom URL scheme,
  and bridging A2UI actions back to the app.
- Platform stance: SwiftUI with Observation (`@Observable`, `@Bindable`) per
  root AGENTS.md; no new `ObservableObject`.
- What to look for (filenames only, do not read impls):
  - Which file owns the custom scheme vs the window lifecycle?
  - Which file looks like the message bridge from A2UI back to Swift?
  - Where does file-watching fit (hot reload of agent-authored assets)?

## Stop 5 - iOS native receiver

- `apps/ios/Sources/RootCanvas.swift` - top-level canvas surface.
- `apps/ios/Sources/Model/NodeAppModel+Canvas.swift` - canvas-shaped extension
  on the shared app model.
- Correction vs the original tour: there is no `*A2UI*` filename on iOS; the
  canvas surface exists but the A2UI-specific glue seen on macOS does not have
  a matching iOS file.
- What to look for:
  - Is iOS a first-class A2UI client or a thinner canvas viewer?
  - How does `NodeAppModel+Canvas` compose with the rest of the app model?
  - Where would an A2UI action handler live if it were added?

## 3 friction questions to collect while reading

1. What crosses the TS <-> native boundary as typed data vs as serialized
   blobs (WS frames, file writes, scheme responses)?
2. Who owns the lifecycle of a session directory - the TS host, the native
   app, or the agent - and when is it garbage-collected?
3. Is the A2UI bundle considered a versioned contract with the native side,
   and what is supposed to fail loudly when `.bundle.hash` drifts?
