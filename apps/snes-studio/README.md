# SNES Studio Standalone

Standalone local-first SNES Studio app for professional Super Nintendo project
planning and hardware-budget validation.

Run it from the repo root:

```sh
pnpm --dir apps/snes-studio dev
```

Open `http://127.0.0.1:5174/`.

Build it:

```sh
pnpm --dir apps/snes-studio build
```

Preview the production build:

```sh
pnpm --dir apps/snes-studio preview
```

Open `http://127.0.0.1:4174/`.

Create the local Mac standalone package after building:

```sh
pnpm --dir apps/snes-studio package:mac
```

The package command writes `apps/snes-studio/release/SNES Studio.app`, a
lightweight macOS app bundle that opens the embedded static SNES Studio build
without requiring the OpenClaw Dashboard.
It also writes `apps/snes-studio/release/signing-report.json`; distribution to
other MacBooks remains blocked until a Developer ID signing identity and Apple
notarization proof are supplied.

This app intentionally shares `packages/snes-studio-core` with the OpenClaw
Dashboard route. Standalone and dashboard workflows must agree on SNES hardware
limits, FXPAK PRO export rules, and project JSON format.

The prompt workflow is approval-gated. Text descriptions produce a local JSON
patch preview with hardware readiness, and the app saves a snapshot before any
approved OpenClaw/Codex-style change is applied.

The app also keeps a bounded session undo/redo history for manual project
edits, imports, resets, and approved agent patches so users can reverse changes
without leaving the local-first workflow. Snapshot actions also add visible
bounded version-history entries that can be restored from the project kit.
Project bundles can export the current canonical project JSON together with
bounded version history for recovery or transfer.

The level canvas is backed by editable 16x12 tile and collision layers. Tile
paint and collision paint modes let cells persist in project JSON, update
collision-cell counts, and compile into the preview ROM tilemap plus
collision-map data with manifest checksums. The scene panel also edits starter
entity names, positions, and metasprite tile budgets for players, enemies,
items, and NPCs.
The level toolbox includes a ground-fill action backed by the same rectangle
paint operation used by tests and bundle-safe project JSON.

The asset panel can import indexed pixel data whose dimensions are multiples of
8 pixels. Imports validate SNES 4bpp palette indices, split source art into 8x8
tiles, deduplicate identical tiles, pack CHR bytes, and store checksumed
tileset metadata in the project file. Imported unique tiles become level-editor
brushes and compile into the preview ROM CHR/tilemap output.

The audio controls create an SPC700 preview manifest that budgets driver
reserve, music pattern data, sound-effect sequences, and sample/BRR space
against the SNES 64 KiB ARAM ceiling before export trust.
The core export plan also maps ARAM offsets and emits a deterministic BRR
silence block marker, but audible playback still requires the production
SPC700 driver to be linked into the ROM.

SuperFX prompts are tracked as explicit concept profiles with FXPAK-compatible
constraints and visible GSU/runtime blockers, instead of being presented as
finished production ROM support.

The prompt panel can also export an OpenClaw/Codex task packet. The packet
includes the current project JSON, SNES/FXPAK PRO hardware constraints, allowed
patch paths, and the approval-only response contract an external agent should
follow before a human applies any changes. Returned OpenClaw/Codex patch JSON
can be pasted back into the app, validated against the allowed path contract,
previewed with hardware readiness, and approved only after the user inspects it.
The same panel can queue a durable `openclaw:snes-studio:codex-task` browser
handoff event in local storage for an OpenClaw/Codex runner to consume when one
is configured.
The shared core includes an injected runner contract that consumes a queued
record, validates returned patch JSON, and produces an approval-ready project
preview; a live OpenClaw/Codex background worker still needs to be wired to that
contract.

The app can also build a deterministic preview `.sfc` runtime artifact for Mode
1 projects. That artifact initializes Mode 1, writes a visible CGRAM backdrop
color, uploads the compiled first-scene CGRAM palette, BG1 CHR tiles, and BG1
tilemap into PPU memory, enables auto-joypad polling, mirrors player 1 state
into WRAM, scrolls BG1 horizontally from left/right input, writes a visible
player OBJ sprite through OAM, applies jump input, gravity, and a ground
collision clamp, writes preview enemy/item/NPC OBJ sprites through OAM, and
includes an internal SNES header, reset vectors, and checksum/complement fields.
It is still a compiler smoke ROM rather than the final generated game runtime.

ROM builds also expose a `.map`, `.build.json` manifest,
`.fxpak-package.json` copy plan, and `.emulator-proof.json` report so the
embedded project-data block, symbols, FXPAK paths, SRAM save manifest,
checksums, static ROM proof, and emulator boot/screenshot readiness can be
inspected before hardware testing. The build path validates preview ROM
integrity before export trust, including reset vector, checksum/complement
fields, runtime-data checksum, SRAM header write opcodes, upload-loop opcodes, controller scroll-loop
opcodes, player OAM write-loop opcodes, entity OAM write-loop opcodes, player
physics-loop opcodes, graphics layout, and required map symbols.

The app also reports emulator proof separately from static ROM proof. If no
supported emulator is available, the build can still export a statically valid
ROM while clearly marking boot/screenshot validation as blocked.
When a supported emulator is detected by an external runner, the core can
produce a boot command and screenshot filename for the proof run; without one,
emulator validation remains blocked by design.
