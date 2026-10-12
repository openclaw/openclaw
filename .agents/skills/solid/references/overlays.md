# Overlays, focus, and the platform floor

## Platform floor

macOS 26.2, iOS 26.2, Safari/WKWebView 26.2, and Chrome/Edge and Firefox from the last ~6 months. This floor landed in `1f634ad4`: deployment targets, appcast minimum, and the boot capability screen with its "Open in browser" path for older browsers. It is what makes the native-first overlay stack possible. Don't add polyfills or fallbacks below it.

## The native-first stack

The shared primitives (menu, popover, tooltip, dialog, tabs) land with the overlay lane. Until they're on `main`, keep existing `wa-*` elements in JSX (`onWa-select`-style events) rather than building a one-off replacement.

- **Positioning:** CSS anchor positioning (`anchor-name`, `position-area`, `position-try-fallbacks`) handles placement, flips, and the 420 px / available-height budgets with no JS positioning writes. No Floating UI. Caret popups anchor to an invisible element placed at the measured caret (`textarea-token-anchor.ts`). Rectangle reads serve pointer intent only.
- **Top layer:** popovers for nonmodal surfaces, so they stay usable above `<dialog>.showModal()`.
  - `popover="auto"` supplies native light dismiss, which **cannot honor a close veto**.
  - Vetoable surfaces (anything that can refuse to close: unsaved input, pending confirmation) use `popover="manual"`, with light dismiss owned by the overlay lifecycle owner.
  - Use `auto` only where nothing can veto. Never run competing native and library dismissal owners.
- **Dialogs:** native `<dialog>` under the existing modal policy (`modal-dialog.ts`: focus entry and return, cancellation, native occlusion leases). Restore focus **synchronously** when the target isn't inside an inert subtree; defer only while inertness is still pending, and drop the deferred restore if the owner disconnects, the target is removed, or newer focus took over. Restoring into an inert subtree drops focus to `body` (Chromium, caught by the Workboard E2E); deferring unconditionally broke synchronous callers (markdown table dialogs).
- **Menus:** the shared Solid `<Menu>` on Zag state machines (`@zag-js/menu`, `@zag-js/vanilla`, `@zag-js/rect-utils` at the pinned version) with OpenClaw's own Solid binding and **roving item focus**. Zag highlights with `aria-activedescendant` by default; OpenClaw needs real focus on items for embedded search fields and controls. Never hand-roll a keyboard model.
- **Native occlusion** (`ui/src/lib/native-overlay-occlusion.ts`) still owns overlap with native views: the top layer doesn't cover native views in the macOS app.

## One lifecycle owner per surface

Every past Web Awesome patch fixed the same root cause: several asynchronous paths each acted as the visibility/focus owner. The overlay lifecycle owner is one accepted-open authority:

- Phases: opening → open → closing → hidden.
- Cancellation is decided **before** listeners, inertness, occlusion, or focus change.
- Completion is never published for a superseded transition.

Preserve:

- prompt usable-state focus, and focus the user moved since
- native Tab exit, and deepest-only nested Escape
- vetoed transitions, and synchronous rollback of rejected controlled values
- sibling-submenu switching that keeps parent navigation (the Web Awesome #135629 bug class)

## Proving overlay changes

Settled screenshots can't prove these races. Exercise:

- input during opening
- close/reopen mid-animation
- late veto
- inside-to-outside drag
- disconnect/remount
- nested Escape
- native overlap while closing

Run every overlay change on **WebKit** as well as Chromium. The frozen overlay contract suites cover the primitives; consumer E2E covers the call sites. Computed-style parity matters across themes, RTL, enlarged text, forced colors, and reduced motion.
