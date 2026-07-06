---
summary: "Platform-only SNES Game Creator milestone runbook for deterministic low-reasoning execution"
read_when:
  - You are advancing reusable SNES Game Creator platform milestones
  - You need low-reasoning milestone execution steps for SNES Studio PCC
  - You need to keep project-specific game work inactive while improving the creator platform
title: "SNES Game Creator Platform Runbook"
---

# SNES Game Creator Platform Runbook

This runbook is for reusable SNES Game Creator platform work only. It improves
contracts, proof templates, orchestration, status, docs, and deterministic QA
that future SNES projects will use.

Do not use this runbook to advance a named game, generate game-specific art,
build a ROM, run emulator gameplay QA, send files, copy to removable media, or
claim hardware proof.

## Required preflight

Run these commands before any platform milestone:

```bash
pnpm docs:list
pnpm snes:mastery status --json
pnpm snes:team -- --mode validate --project demo-pcc-v2 --json
pnpm snes:team -- --mode next --project demo-pcc-v2 --json
git status --short
```

Stop if SNES mastery is not `15/15` katas and `17/17` generic milestones, PCC
validation fails, or an implementation step would touch unrelated dirty files.

## Allowed platform surfaces

Allowed platform work:

- generic asset intent contracts;
- generic hardware proof plan templates;
- low-reasoning runbooks;
- generic PCC status and dashboard snapshot data;
- PCC receipts for generic platform milestones.

Forbidden without a separate explicit approval:

- named-game milestones or assets;
- hosted GLM;
- paid tools or paid assets;
- commercial SNES ROMs, code, art, maps, palettes, music, SFX, leaks, or
  disassemblies;
- ROM builds and emulator gameplay runs;
- FXPAK, SD card, or removable-media writes;
- Discord/file delivery;
- staging, committing, pushing, publishing, or opening a PR.

## Low-reasoning milestone loop

1. Inspect current status with `pnpm snes:team -- --mode next --project demo-pcc-v2 --json`.
2. Select only the first ready generic platform milestone.
3. Read the milestone Definition of Done and required proof names.
4. Create or update only generic platform code, docs, tests, or PCC receipts.
5. Run the targeted tests for the touched surface.
6. Run PCC validation.
7. Run `next` again and verify the milestone moved forward or is honestly blocked.
8. Report completed work, incomplete work, blockers, and completion percentages.

Never mark a milestone `pass` unless every required proof path exists, validators
pass, and the milestone judge has no missing proof.

## Generic MVP closure command

When the next ready milestone is `PCC-020-integration`, use the deterministic
platform MVP closure command instead of receipt-only worker adapter output:

```bash
pnpm snes:team -- --mode complete-platform-mvp --project demo-pcc-v2 --json
```

This command may complete these generic platform milestones only:

- `PCC-020-integration`
- `PCC-030-rom-build-proof`
- `PCC-040-runtime-proof`

It must use already validated legal clean-room generic SNES mastery receipts
from `.artifacts/snes-game-builder-reference/`. It must stop at
`PCC-050-human-visual-approval` and create an approval request instead of
self-approving visuals. It must not run a named-game build, emulator gameplay
QA, Discord send, FXPAK write, or hosted model call.

When the human has approved the generic platform runtime visuals, apply that
approval explicitly:

```bash
pnpm snes:team -- --mode apply-human-visual-approval \
  --project demo-pcc-v2 \
  --milestone PCC-050-human-visual-approval \
  --approval-note "generic SNES Game Creator MVP runtime visuals human-approved for this checkpoint" \
  --json
```

Then rerun `complete-platform-mvp` to complete `PCC-060-package-readiness`.

## Prompt-to-game prototype commands

Use the PCC `create-game` mode for the platform-safe prompt-to-game prototype:

```bash
pnpm snes:team -- --mode create-game \
  --project demo-created-game \
  --template platformer \
  --prompt fixtures/snes-demo-prompt.txt \
  --json
```

The same behavior is available through the standalone wrapper:

```bash
node scripts/snes-create-game.mjs \
  --project demo-created-game \
  --template platformer \
  --prompt fixtures/snes-demo-prompt.txt \
  --json
```

This initializes a generic PCC project, attaches a reusable clean-room template,
validates the state, and emits the first worker packet. It does not call hosted
models, download commercial material, build a ROM, or write removable media.

Reusable templates are listed with:

```bash
pnpm snes:team -- --mode list-templates --json
```

Available template ids are `platformer`, `top-down-adventure`, `maze-action`,
`shooter`, and `puzzle-platformer`.

The package script alias `pnpm snes:create-game` is intentionally not required
for this milestone because `package.json` may contain unrelated dirty-tree work.
Use `pnpm snes:team -- --mode create-game` until a clean package-script change
is separately approved.

## Generic platform validators

Validate a production-facing sprite intent:

```bash
pnpm snes:team -- --mode asset-intent-validate \
  --asset-intent fixtures/generic-sprite-intent.json \
  --json
```

Validate the generic production art pipeline contract:

```bash
pnpm snes:team -- --mode asset-pipeline-validate \
  --asset-pipeline fixtures/generic-asset-pipeline.json \
  --json
```

Validate a generic level JSON contract:

```bash
pnpm snes:team -- --mode level-validate \
  --level fixtures/generic-level.json \
  --json
```

Run the clean-room prompt-to-ROM regression benchmark scaffold:

```bash
pnpm snes:team -- --mode regression-benchmark \
  --project demo-pcc-v2 \
  --json
```

Refresh dashboard data for visual approval and platform readiness:

```bash
pnpm snes:team -- --mode dashboard-snapshot \
  --project demo-pcc-v2 \
  --json
```

## Generic proof requirements

Asset intent milestones must prove:

- asset id, kind, dimensions, frame count, palette limit, runtime proof flag;
- production-facing visual assets include a human visual target;
- positive fixture passes;
- negative fixtures fail for missing dimensions, palette overflow, missing
  runtime proof, and project-specific references;
- no named-game path is active.

Hardware plan milestones must prove:

- emulator launch proof is separate from screenshot/runtime proof;
- screenshot/runtime proof is separate from FXPAK copy proof;
- FXPAK copy proof stays blocked/manual until the exact mounted path and user
  approval exist;
- original hardware proof stays blocked/manual until a human performs it;
- no removable-media write is performed by a template.

## Status reporting

Every platform-only report must include:

- generic kata count;
- generic milestone count;
- next generic PCC milestone;
- blocked generic proof surfaces;
- legal clean-room status;
- local model policy status;
- explicit statement that project-specific game production is inactive.

Completion language must distinguish platform readiness from finished-game
production.

## SNES Asset Studio v1

SNES Asset Studio turns a user-provided image into a local, deterministic, SNES-safe asset candidate. It is platform-only infrastructure: it preserves the original source image, creates an asset intent, converts the image into a 16-color indexed PNG sprite sheet, creates a contact sheet, and writes receipts that keep static asset proof separate from runtime ROM proof.

Use the script alias when available:

```bash
pnpm snes:asset-studio -- preserve --project <project-id> --asset-id <asset-id> --kind sprite --source <image-path> --json
pnpm snes:asset-studio -- intent --project <project-id> --asset-id <asset-id> --kind sprite --dimensions 32x32 --frames 4 --json
pnpm snes:asset-studio -- convert --project <project-id> --asset-id <asset-id> --fit contain --frame-layout horizontal --json
pnpm snes:asset-studio -- contact-sheet --project <project-id> --asset-id <asset-id> --json
pnpm snes:asset-studio -- pipeline --project <project-id> --asset-id <asset-id> --json
pnpm snes:asset-studio -- insert --project <project-id> --asset-id <asset-id> --target player.sprite --json
pnpm snes:asset-studio -- runtime-proof-plan --project <project-id> --asset-id <asset-id> --json
pnpm snes:asset-studio -- compile --project <project-id> --asset-id <asset-id> --json
pnpm snes:asset-studio -- runtime-demo --project <project-id> --asset-id <asset-id> --json
pnpm snes:emulator:headless-proof -- --rom <runtime-demo.sfc> --artifact-dir <runtime-emulator-proof-dir> --expected-rom-sha256 <rom-sha256> --json
pnpm snes:asset-studio -- runtime-proof --project <project-id> --asset-id <asset-id> --rom <runtime-demo.sfc> --screenshot <runtime.png> --expected-rom-sha256 <rom-sha256> --emulator-receipt <runtime-emulator-proof-dir>/receipt.json --json
pnpm snes:asset-studio -- approve-visual --project <project-id> --asset-id <asset-id> --approval-note "<human note>" --production false --json
```

Completion rules:

- Source preservation, conversion, contact sheet, and manifest insertion are not runtime proof.
- `compile` creates source/header metadata for an inserted asset, but it is still not a ROM build.
- `runtime-demo` builds a clean-room PVSnesLib ROM and runs SuperFamicheck, but it is still not emulator screenshot proof.
- `runtime-proof` verifies an explicit ROM, expected ROM SHA, emulator proof receipt, and runtime screenshot artifact; it does not run an emulator by itself.
- `approve-visual --production true` requires runtime proof first. Non-production approval can record a checkpoint but cannot satisfy production art.
- Runtime proof still requires a ROM build plus emulator screenshot/OAM/tilemap signature.
- Production art still requires human visual approval.
- Local redraw attempts must stay local-only. If no local image generator is configured, write a blocked receipt instead of falling back to hosted providers.
- Do not use commercial game names, copied commercial assets, source leaks, disassemblies, hosted image generation, hosted GLM, paid tools, FXPAK writes, Discord delivery, or named-game scope while running platform-only work.

The SNES Studio dashboard exposes the same local pipeline through the
`snes.assetStudio.pipeline` Gateway method. It can accept a local uploaded image
or run the bundled clean-room fixture, then preserve, convert, contact-sheet,
insert, and compile the asset. The dashboard must keep the result label explicit:
runtime proof is still required and static insertion is not a ROM proof. When
`buildRuntimeDemo` is true, the Gateway pipeline adds the clean-room runtime demo
ROM stage. When `runHeadlessEmulatorProof` is true, it also runs the local
headless emulator proof and only labels runtime proof as passed after the
emulator screenshot and runtime-proof receipts pass.
