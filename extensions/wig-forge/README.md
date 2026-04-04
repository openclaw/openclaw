# Wig Forge

`wig-forge` is an OpenClaw plugin prototype for the product loop we aligned on:

`web capture -> cutout / normalize -> rarity + appearance roll -> mint -> inventory -> equip`

And now:

`wish -> list for wig -> buy -> transfer ownership -> restyle the bot room`

## Why this plugin exists

The most important part of the reward system is not the wallet. It is the moment where a real visual object from a web page becomes a bot-owned digital asset with:

- a slot
- a rarity
- a visual variant
- a source fingerprint
- an owner inventory entry

This extension is the first repo-native step toward that.

## Reference architecture used for the plan

This implementation is intentionally shaped around proven pieces we can grow into:

- Browser extension shell: `content script + background worker`, with Safari following the same WebExtension model.
- DOM/region capture: `SnapDOM` and `html2canvas` style capture pipelines, with browser tab capture as the last fallback.
- Interactive segmentation: MediaPipe `InteractiveSegmenter` as the main user-guided mask path.
- Heavier local CV fallback: `Transformers.js`, ONNX Runtime Web, and SAM-style web inference for later quality mode.
- Post-mask cleanup: OpenCV.js morphology.
- Layered wearable rendering: `PixiJS` paper-doll style composition rather than true 3D for MVP.

## Repo additions in this phase

This extension now includes two layers:

- OpenClaw plugin tools and HTTP routes
- a browser extension prototype for webpage element capture, cutout, preview, and forge

## MVP scope implemented here

- Browser extension capture flow
  - Popup for gateway URL and `inventoryKey`.
  - In-page selection mode with hover highlight.
  - Background `captureVisibleTab` screenshot capture.
  - MediaPipe `InteractiveSegmenter` running in a dedicated worker.
  - Automatic fallback to the local point-guided heuristic when MediaPipe is unavailable.
  - Preview sheet for name and slot override before minting.
- Collection room
  - `GET /plugins/wig-forge/room` renders a browser gallery for one inventory key.
  - `GET /plugins/wig-forge/file` serves preview, sprite, and source files for forged assets.
  - `POST /plugins/wig-forge/equip` lets the room equip an asset into its slot.
  - `GET /plugins/wig-forge/wishes` lists active and granted wishes for one inventory key.
  - `POST /plugins/wig-forge/wishes` records a wish so the bot can want a real item instead of hallucinating ownership.
  - `POST /plugins/wig-forge/grant` grants a matching owned asset to a recorded wish and equips it.
  - `GET /plugins/wig-forge/market` exposes live listings plus recent sales for the current room.
  - `POST /plugins/wig-forge/market/list` lists an owned asset for a wig price.
  - `POST /plugins/wig-forge/market/cancel` withdraws an active listing.
  - `POST /plugins/wig-forge/market/buy` purchases an active listing, moves the asset across inventories, and settles wig balances.
  - Loadout, spotlight, gallery, wish wall, figure stage, and bazaar are visualized as a lightweight “collection room” for bots and operators.
- `wig_forge_mint`
  - Accepts a capture image as a data URL or base64 payload.
  - Detects mime and image metadata.
  - Computes exact source fingerprint.
  - Applies duplicate-aware novelty decay.
  - Infers a wearable slot.
  - Rolls rarity from novelty, mask quality, task quality, style fit, and luck.
  - Generates a lightweight visual variant with palette shift and optional glow.
  - Stores the source and generated sprite in the workspace.
- `wig_inventory_list`
  - Reads the forged asset inventory for the current agent/workspace.
- `wig_inventory_equip`
  - Equips a minted asset into its slot.
- `wig_wish_create`
  - Records a concrete wearable wish for the current bot inventory.
- `wig_wish_list`
  - Lists active and granted wishes.
- `wig_wish_grant`
  - Grants a recorded wish with a matching owned asset and equips it.
- `POST /plugins/wig-forge/forge`
  - Accepts a browser-side cropped capture and mints it over HTTP.
- `GET /plugins/wig-forge/inventory`
  - Returns the current inventory JSON for a named browser inventory key.
- `GET /plugins/wig-forge/room`
  - Displays a collection-room UI with spotlight reveal, equipped slots, wish wall, and a gallery of forged assets.
- `GET /plugins/wig-forge/file`
  - Serves preview, sprite, or source files for one forged asset.
- `POST /plugins/wig-forge/equip`
  - Equips a forged asset for one browser inventory key.
- `GET /plugins/wig-forge/wishes`
  - Lists recorded wishes for one browser inventory key.
- `POST /plugins/wig-forge/wishes`
  - Creates a wish for one browser inventory key.
- `POST /plugins/wig-forge/grant`
  - Grants a wish with a matching owned asset and equips it.
- `GET /plugins/wig-forge/market`
  - Lists active market offers and recent sales for one browser inventory key.
- `POST /plugins/wig-forge/market/list`
  - Lists one forged asset for sale in wig.
- `POST /plugins/wig-forge/market/cancel`
  - Cancels one active listing.
- `POST /plugins/wig-forge/market/buy`
  - Buys one active listing, moves the asset to the buyer inventory, and updates both wig balances.

## UX direction

Research-backed product and interaction notes now live at:

`extensions/wig-forge/UX_RESEARCH.md`

That doc captures the current direction for:

- `reveal -> collection room -> wish wall` as the core loop
- motion timing and reduced-motion fallbacks
- retention mechanics
- creator / bazaar expansion space
- random drop refinement ideas

## Smoke verification

A reusable browser smoke harness now lives at:

`extensions/wig-forge/scripts/smoke.ts`

Run it with:

`node --import tsx extensions/wig-forge/scripts/smoke.ts`

It launches Chromium with the unpacked extension, opens a local test page,
triggers selection, forges a wearable, opens the collection room, equips the
drop, and stores screenshots plus a JSON summary under:

`output/playwright/wig-forge/`

## Current storage model

By default the plugin stores data under:

`<workspace>/.openclaw/wig-forge/`

Inside it:

- `inventory.json`
- `market.json` in the shared market root when bazaar is used
- `assets/<asset-id>/source.*`
- `assets/<asset-id>/sprite.png`
- `assets/<asset-id>/preview.png`

If the tool is called outside a workspace, it falls back to a temp directory.

If `storageDir` is configured, storage becomes shared and segmented by agent or
inventory key:

`<storageDir>/<agent-or-inventory-key>/...`

That is the easiest way to make browser-forged assets and tool-driven inventory
look at the same underlying data.

## Cloudflare R2 storage

`wig-forge` can now mirror forged asset files into Cloudflare R2 while keeping
the local filesystem copy intact.

What gets synced:

- `source.*`
- `sprite.png`
- `preview.png`
- `vector.svg`

What the plugin expects:

- `WIG_FORGE_R2_ACCOUNT_ID`
- `WIG_FORGE_R2_BUCKET`
- `WIG_FORGE_R2_ACCESS_KEY_ID`
- `WIG_FORGE_R2_SECRET_ACCESS_KEY`

Optional but recommended:

- `WIG_FORGE_R2_PUBLIC_BASE_URL`
  Use your R2 custom domain here, for example `https://assets.yourdomain.com`.
  When present, the room UI will prefer Cloudflare-hosted asset URLs directly.
- `WIG_FORGE_R2_KEY_PREFIX`
  Defaults to `wig-forge`.

You can also provide the same values through plugin config under `r2`.

Example shape:

```json
{
  "storageDir": "/absolute/path/to/wig-forge-store",
  "r2": {
    "accountId": "your-cloudflare-account-id",
    "bucket": "veil-assets",
    "accessKeyId": "your-r2-access-key-id",
    "secretAccessKey": "your-r2-secret-access-key",
    "publicBaseUrl": "https://assets.example.com",
    "keyPrefix": "veil"
  }
}
```

To backfill already-forged local assets into R2:

`node --import tsx extensions/wig-forge/scripts/r2-backfill.ts /absolute/path/to/shared/storage`

That script updates each `inventory.json` with the new public file URLs after upload.

## Deliberate non-goals for this first commit

- Market and trading
- True 3D asset generation
- Desktop/global floating pet rendering
- Multi-click scribble segmentation or OpenCV cleanup passes

Those come after the mint/inventory/equip contract is stable.
