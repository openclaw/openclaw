# Wig Forge Browser Extension Prototype

This is a minimal Manifest V3 browser extension that lets you:

1. open the popup
2. set the local OpenClaw gateway URL
3. choose an `inventoryKey`
4. start element selection on the current page
5. click a visible element
6. review the cutout preview, edit the name, and choose a slot
7. send the capture to `POST /plugins/wig-forge/forge`

The current prototype now does a point-guided local cutout inside the clicked
element rect before minting. The primary path uses MediaPipe
`InteractiveSegmenter` inside a dedicated worker, and it automatically falls
back to the lightweight local heuristic if MediaPipe cannot initialize.

It also presents a small confirm sheet before minting so the user can:

- preview the cutout
- tweak the asset name
- override the target slot

## Shortcuts

- `Cmd/Ctrl + Shift + K`: first press enters capture, second press forges the currently hovered fragment
- `Esc`: cancel selection mode or close the preview sheet
- `Cmd/Ctrl + Enter`: confirm forge from the preview sheet after a click-based refined capture

After minting, the forged asset can be inspected and equipped through the
plugin-hosted collection room at:

`/plugins/wig-forge/room?inventoryKey=<your-key>`

## Current limitations

- It captures the **visible viewport only**
- It currently uses a single-point prompt, not scribbles or multi-click refinement
- The prototype manifest uses `<all_urls>` so automated capture works reliably across pages
- It assumes the OpenClaw gateway is reachable on `http://127.0.0.1:18789`
- Shared browser/tool inventories work best when the plugin config sets a shared `storageDir`
- Safari packaging is not done yet

## Load unpacked

Chrome / Chromium:

1. Open `chrome://extensions`
2. Enable Developer Mode
3. Click **Load unpacked**
4. Select this folder:

`extensions/wig-forge/browser-extension`

## Browser smoke

An end-to-end smoke script is included:

`node --import tsx extensions/wig-forge/scripts/smoke.ts`

It verifies capture, preview, forge, collection-room display, and equip.

Artifacts land in:

`output/playwright/wig-forge/`

## Best next upgrades

- Add scribble and multi-point prompting for harder cutouts
- Add post-mask cleanup with OpenCV.js morphology
- Add a tiny result preview in the popup
- Support Safari packaging once the capture flow stabilizes
