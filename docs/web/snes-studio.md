---
summary: "SNES Studio dashboard for AI-first side-scrolling platformer projects"
read_when:
  - You want to use or change the SNES Studio dashboard
  - You are working on AI-first creation, playable simulation, or hardware-aware export planning
title: "SNES Studio"
---

SNES Studio is a local-first Control UI dashboard for making Super Nintendo game
projects with a GPT 5.5-directed OpenClaw Game Team.

The default experience is now SNES Studio's one-prompt flow for one beginner-friendly
game type first: story-driven side-scrolling platformers.

1. Describe the game.
2. GPT 5.5 creates the blueprint, quality rubric, risk list, playtest metrics, and OpenClaw role
   tasks.
3. OpenClaw fills the game plan, level chapters, cast, items, rules, save plan,
   and first playable level.
4. Deterministic validation and playtest metrics run, then GPT 5.5 approves or disapproves playtest/export.
5. Play it in the emulator-like canvas.
6. Click a thing or drag-select an area on the game screen.
7. Prompt OpenClaw to add, remove, or change what was selected.
8. Drag/drop tune the level where useful.
9. Export a SNES game file.

Dense professional tools are still available, but they live behind **Expert
Studio** so the beginner path stays clear.

## Guided Builder

The first screen shows one obvious action:

- One game prompt.
- AI production team status: **GPT 5.5 Game Director**, **OpenClaw Game Team**, deterministic validation, and
  **GPT 5.5 Quality Gate**.
- **Make My Game**.
- Starter prompt chips.
- Nothing else from the professional workbench unless **Expert Studio** is opened.

After AI makes the draft, the guided steps are **Idea**, **Game Plan**, **Build
Levels**, **Make Things**, **Play & Change**, and **Create Game File**.

## Game Plan And Gap Filling

The production loop now creates a full game draft rather than only a first level:

1. **GPT 5.5 Game Director** writes the game blueprint, quality rubric, risks, playtest metrics, and
   role-agent task briefs.
2. **OpenClaw Game Team** fills the editable text boxes and game parts.
3. **Deterministic Validation** checks schema, patch safety, first-level playability, rewards,
   SNES constraints, and export readiness.
4. **GPT 5.5 Quality Gate** approves or disapproves the draft with exact OpenClaw repair instructions.
5. **OpenClaw Game Team** applies required GPT 5.5 repairs, then GPT 5.5 performs the final approval gate.

The Game Plan contains the premise, world, hero goal, villain, conflict, ending,
tone, items, music mood, save plan, and plain gameplay rules. **Build Levels**
shows levels as chapters with a purpose, setting, challenge, reward, and goal.

Cost control is part of the contract. The **Producer Orchestrator** owns the
project manifest, milestone order, token policy, pass/fail decisions, and role
receipts. OpenClaw local workers handle normal creative generation, text boxes,
level edits, selected-object changes, and gap filling. GPT 5.5 is reserved for
high-leverage gates only: initial blueprint/rubric, concise QA summaries, repair
briefs, repeated blocker diagnosis, major design conflicts, approved visual
review, and final shipping approval. Routine milestone patch generation records
`gpt55Used: false`, `reasoningLevel: none`, and the local-worker cost avoided.
Generic agent task helpers default to OpenClaw so new prompt surfaces do not
accidentally spend Codex calls.
SNES Studio also ships a local model benchmark ladder for the worker roles. It
does not promote a model just because it is installed; candidates must beat the
current worker default on JSON validity, asset specificity, fair enemy tuning,
hardware QA correctness, and deterministic playtest quality before they become a
default route.

## Production SNES Studio

The reusable production builder is generic. Stanski's World is now treated as a
canary sample, not as a special runtime path. Every game can be represented as an
`openclaw-snes-project-package` that contains:

- a versioned game manifest;
- asset registry records and conversion receipts;
- browser-preview, QA, ROM, emulator, FXPAK, and hardware proof receipts;
- production readiness gates that keep browser preview, real assets, visual
  approval, `.sfc` ROM build, emulator proof, FXPAK package, and original-SNES
  hardware proof separate.

The dashboard groups the builder into five modes:

1. **Create** for the prompt-first MVP.
2. **Edit** for object, level, mechanic, and selected-area changes.
3. **Art Lab** for sprites, tilesets, palettes, backgrounds, music, SFX, and
   visual approval.
4. **Playtest** for deterministic browser replay, quality gates, and human
   visual grading.
5. **Ship** for ROM build status, emulator proof, FXPAK package planning, and
   hardware proof checklist.

Production cannot be marked complete from prose, procedural previews, or
converted placeholder PNGs. Real graphics require source paths, hashes,
provenance, palette/frame/tile metadata, visual maturity, and review proof
artifacts. Source PNGs do not count as screenshot proof. Human visual grade
overrides synthetic visual scores. Browser preview never counts as ROM proof;
ROM proof never counts as emulator or FXPAK proof; hardware proof remains
manual.

The **100/100 Visual Board** separates graphics into production-approved art,
editable Pixelorama/Tiled source art, imported/converted source art, and
spec-only/procedural placeholder art. Stanski Level 1 currently carries a human
visual rejection receipt at **3/100** for in-game screenshots, with sprite sheets
at 72/100, the tileset at 20/100, and the background layer at 8/100. SNES Studio
must block production and FXPAK production export until a human 100/100 approval
receipt exists. Art Lab
shows asset cards for sprites, enemies, items, tilesets, backgrounds, UI, music,
and SFX with source path/hash, provenance, conversion metadata, maturity state,
in-game usage, review proof, and any visual blocker. Local OpenClaw/GLM may
create structured art manifests, but procedural blobs/grids are placeholder-only
and cannot pass production visuals.

The visual recovery command sequence is
`pnpm snes:toolchain -- visual-reject --project-id stanskis-world --level-id w1-1-cleveland-skyline-scramble --human-score 3 --json`,
`pnpm snes:toolchain -- project-art-bible --project-id stanskis-world --level-id w1-1-cleveland-skyline-scramble --json`,
`pnpm snes:toolchain -- project-art-source-pack --project-id stanskis-world --level-id w1-1-cleveland-skyline-scramble --json`,
`pnpm snes:toolchain -- project-art-compile --project-id stanskis-world --json`,
`pnpm snes:toolchain -- project-conversion --project-id stanskis-world --json`,
`pnpm snes:toolchain -- project-visual-proof --project-id stanskis-world --json`,
`pnpm snes:toolchain -- project-visual-proof --project-id stanskis-world --proof-source runtime-capture --json`,
`pnpm snes:toolchain -- project-runtime-asset-truth --project-id stanskis-world --json`,
and `pnpm snes:toolchain -- project-visual-quality-audit --project-id stanskis-world --json`. The runtime asset-truth receipt proves whether compiled source assets are actually listed in the ROM/runtime receipt, bound to converted SuperFamiconv pixel output, and backed by runtime or emulator screenshot proof. Synthetic composite screenshots are diagnostic only and cannot satisfy production visual proof. The quality audit records the current human category grades: in-game screenshots 3/100, all sprite sheets 72/100, tileset 20/100, and background layer 8/100. It also blocks when runtime asset truth is not proven, meaning screenshots exist but do not prove the improved sprite/tile/background source pixels are actually rendered in the ROM. Only after actual human review may the operator run `pnpm snes:toolchain -- project-visual-approval --project-id stanskis-world --human-score 100 --confirm-human-reviewed-visuals --approver human-operator --review-note "reviewed contact sheets, atlases, composites, and in-game screenshots" --json`. Without the confirmation flag and review note, a 100/100 approval command blocks instead of promoting the assets.
The Visual Board buttons call the same local Gateway-backed commands: **Reject
3/100 Visuals**, **Build Art Bible**, **Create Source Pack**, **Create Art
Manifest**, **Compile Art**, **Capture Visual Proof**, **Prove Runtime Assets**, **Audit Visual Quality**, and **Approve Visuals**.
These actions write receipts; they do not use hosted GLM, hosted image/video
providers, or GPT 5.5 visual judging.

The internal generic production runner stores the project package plus backlog,
current milestone, completed milestones, blockers, memory cards, QA receipts, and
latest summary under `.artifacts/snes-projects/<projectId>/`. The project
manifest is the source of truth; agents receive compact packets plus relevant
memory cards, not the full transcript. Every role handoff must include the
surface changed, patch path/hash, assumptions, risks, playtest hypothesis, QA
evidence required, next role, blocker, GPT 5.5 use, reasoning level, and local
model used. The dashboard calls
the generic Gateway methods `snes.production.status`, `snes.production.continue`,
`snes.production.auto`, `snes.production.pause`, `snes.production.resume`,
`snes.production.cancel`, `snes.production.splitNext`, and
`snes.production.retryBlocked`. Local GLM/OpenClaw workers receive one compact
milestone packet at a time and must return strict JSON with `localGlmOnly: true`
and `hostedGlmUsed: false`. Routine milestone execution records
`gpt55Used: false`; GPT 5.5 is reserved for initial blueprint, repeated blocker
diagnosis, major architecture decisions, or final visual approval when explicitly
used.

The Toolchain Doctor is read-only unless the user explicitly approves installs.
The live Gateway method `snes.toolchain.status` detects or reports blockers for
PVSnesLib, SuperFamiconv, Pixelorama, LDtk, Tiled, Mesen/MesenCE, bsnes,
SuperFamicheck, BRRtools, optional Aseprite, and FXPAK/SD2SNES-style FAT32 media.
The dashboard also shows fixture-backed adapter receipts, a PVSnesLib ROM
scaffold dry-run, emulator proof plan, and FXPAK copy dry-run. Browser preview,
real asset conversion, real `.sfc` builds, emulator launch, and FXPAK writes are
separate proof surfaces.

After explicit approval for free/accountless local tool setup, use the local
toolchain runner:

```bash
pnpm snes:toolchain -- probe --json
pnpm snes:toolchain -- install --json
pnpm snes:toolchain -- conversion-smoke --json
pnpm snes:toolchain -- rom-smoke --json
pnpm snes:toolchain -- emulator-smoke --json
```

The runner installs or registers tools under
`~/.openclaw/snes-toolchain`, writes the manifest at
`~/.openclaw/snes-toolchain/toolchain-manifest.json`, and stores receipts under
`.artifacts/snes-toolchain/`. It does not use hosted GLM, does not use GPT 5.5 as
a visual judge, does not bypass Gatekeeper, and does not write to FXPAK,
SD2SNES, or other removable media. The real conversion smoke creates an
original PNG fixture and converts it with SuperFamiconv into SNES tile, map, and
palette outputs. The real ROM smoke builds a PVSnesLib `.sfc` and records the
SuperFamicheck header/checksum receipt when available. The emulator smoke
launches the built ROM with the detected local emulator and records either a
screenshot proof or a launch receipt if screen capture is unavailable.

After the smoke lane is green, project-level proof uses the same local toolchain
against a persisted SNES project package:

```bash
pnpm snes:toolchain -- project-conversion --project-id comet-fox-mvp --json
pnpm snes:toolchain -- project-rom --project-id comet-fox-mvp --json
pnpm snes:toolchain -- project-engine-rom --project-id comet-fox-mvp --json
pnpm snes:toolchain -- project-emulator --project-id comet-fox-mvp --json
pnpm snes:toolchain -- project-engine-emulator --project-id comet-fox-mvp --json
pnpm snes:toolchain -- fxpak-dry-run --project-id comet-fox-mvp --json
```

Project conversion materializes deterministic local PNG source assets for
spec-only required graphics, converts them with SuperFamiconv, and writes
input/output hashes under `.artifacts/snes-projects/<projectId>/toolchain/`.
It proves only the asset pipeline; it does not claim human visual approval. The
project ROM command generates a PVSnesLib project from the project package,
embeds project id/title and the asset conversion hash in the generated source,
builds a real scaffold `.sfc`, and runs SuperFamicheck. The project engine ROM
command builds the first reusable PVSnesLib platformer runtime proof with
controller movement, jump/gravity, collision floor, enemy marker, collectible,
goal, and engine feature receipt. The project emulator commands launch the
latest passing scaffold or engine ROM in MesenCE, bsnes, or SNES9x and record
launch proof plus screenshot proof when macOS capture allows it. Scaffold ROM
proof is not production gameplay proof; production readiness requires the
separate engine runtime proof gate.

SNES Studio now fails closed on text-mode engine scaffolds. A ROM generated from
`hello_world.c`, `consoleDrawText` gameplay, `"@"` player markers, or without
real BG tilemap, metasprite/OAM, gameplay, and audio runtime evidence is marked
`rejected-scaffold`. Rejected scaffold ROMs may remain as diagnostic artifacts,
but they cannot satisfy gameplay proof and cannot be exported to FXPAK.

Runtime maturity is tracked separately from ROM build success. A ROM can pass
SuperFamicheck and still be only a `scaffold` or `single-screen-runtime`.
Stanski's World Level 1 export requires at least `production-candidate-level`,
which means the receipt proves a scrolling level, camera bounds, real collision,
metasprite objects, a finishable ending state machine, and runtime-integrated
audio. The dashboard shows this maturity state so "ROM builds" is never confused
with "the level is production grade."

FXPAK or SD2SNES writes require an exact volume and an explicit write flag:

```bash
pnpm snes:toolchain -- fxpak-transfer-package --project-id stanskis-world --json
pnpm snes:toolchain -- fxpak-dry-run --project-id comet-fox-mvp --fxpak-volume /Volumes/FXPAK --json
pnpm snes:toolchain -- fxpak-copy --project-id comet-fox-mvp --fxpak-volume /Volumes/FXPAK --confirm-fxpak-volume /Volumes/FXPAK --allow-fxpak-write --json
```

When the FXPAK Pro SD card is mounted on another machine, use
`fxpak-transfer-package`. It creates a local export folder containing the
verified `.sfc`, SHA-256 receipt, SuperFamicheck context, and MacBook handoff
instructions for copying only that ROM to `FXPAK/Games`. It does not write to
`/Volumes`, does not create SD-card directories, and does not modify `.srm` save
files.

The copy command refuses auto-detected-only writes, non-`/Volumes` paths,
non-FAT32 media, missing destination roots, existing destination ROMs, SRAM
writes, and mismatched confirmation paths. It copies only the approved `.sfc`
file and verifies the copied SHA-256 before writing a pass receipt.

## Stanski's World Batch 1

`stanskis-world` is the first full production project to use the generic SNES
Studio package path. The full 8-world plan remains preserved for later, but the
active production target is now **Level 1 only: Cleveland: Skyline Scramble**.
The package still keeps the full canon, references, Secret World 9, The Auditor,
true ending, later worlds, and release-candidate proof as planned backlog items;
they are not treated as failed or complete.

The Stanski package stores its durable data under
`.artifacts/snes-projects/stanskis-world/`:

- `project.json` for the generic SNES Studio project package;
- `references/` for copied prompt files, source-image receipts, and canon
  summaries;
- `production/backlog.json`, `state.json`, `memory-cards.json`,
  `decision-log.json`, and `latest-summary.md`;
- `qa/` and `toolchain/` receipts from project conversion, ROM, emulator, and
  FXPAK dry-run commands.

The locked Batch 1 canon keeps the target platform as original SNES via FXPAK
Pro, with optional enhancements disabled by default. FXPAK writes remain blocked
until the operator provides a real exact mounted FAT32 volume path. Visual
quality remains human-gated at 100/100.

World 1 data includes Cleveland: Skyline Scramble, Detroit: Motor City Mayhem,
Lakewood: Warren Road Roof Run, Edgewater Ticket Cache, Turnpike Toll Trouble,
and the Fare Snatcher boss. Fare Snatcher grants Golden Transfer Pass #1.
Lakewood/Warren Road house requirements, toilet endings, Secret World 9, Receipt
Reality, Back of the Map, The Auditor, the true ending, the Todd drawing
reference, and the man-and-boy photo inclusion requirement are preserved as
canon/reference data before implementation.

The Level 1 active slice records its own definition of done: `World: Cleveland`
and `Level: 1` opening overlay, five starting lives, walk/run/jump, 1.5× run
speed, 1.5× falling gas boost, crouch/projectile origins, cheeseburger onboarding
in the first 30 seconds, a fair first enemy, early burrito block, pizza before a
projectile-required enemy, one checkpoint, one reachable secret route, and a
toilet ending with Todd sitting, newspaper, exactly two poop drops, and fireworks.
The deterministic Level 1 package includes sections, gameplay objects, SNES
budget, and a replay script that ends at the toilet. Browser playtest proof, ROM
proof, visual approval, emulator proof, FXPAK copy, and original hardware proof
remain separate gates.

Batch 2 closes the man-and-boy reference gap only when the source photo is
readable locally. The reference id is `man-boy-snes-photo-reference`. Its planned
use is the **Family Memory Card** secret room cameo in World 1, with an optional
ending or credits memory-card reuse after visual QA. The source photo is
reference media first: a preserved hash and dimensions prove provenance, not
production in-game art. SNES Studio must not claim the cameo appears in-game
until a converted SNES-safe asset and executable visual proof show it in the
runtime. If the Photos temp path is stale or the attachment is unavailable, the
project must keep the reference blocked with `source image unavailable`.

Batch 3 converts that preserved source into what the SNES can actually show. For
`backgroundLayer` image assets, the local image converter crops the source into a
96×64, 8×8-tile-aligned **Family Memory Card** panel, maps it to one 16-color
SNES-safe palette with ordered dithering, writes a contact/review sheet, and
records the asset as `draft-generated`. The converted PNG can feed
SuperFamiconv/project conversion, but it still does not count as
production-approved art until in-game visual proof and human visual approval pass.

Level 1 proof commands:

```bash
pnpm snes:toolchain -- reconcile-production-state --project-id stanskis-world --json
pnpm snes:toolchain -- project-conversion --project-id stanskis-world --json
pnpm snes:toolchain -- project-visual-proof --project-id stanskis-world --json
pnpm snes:toolchain -- project-browser-playtest --project-id stanskis-world --level-id w1-1-cleveland-skyline-scramble --json
pnpm snes:toolchain -- project-visual-review-pack --project-id stanskis-world --level-id w1-1-cleveland-skyline-scramble --json
pnpm snes:toolchain -- project-engine-rom --project-id stanskis-world --json
pnpm snes:toolchain -- project-engine-emulator --project-id stanskis-world --json
pnpm snes:toolchain -- fxpak-transfer-package --project-id stanskis-world --json
pnpm snes:toolchain -- fxpak-dry-run --project-id stanskis-world --json
```

Those commands produce receipt-backed state or exact blockers. Conversion may
use reference/source assets with non-production maturity. The browser playtest
checks Stanski-specific Level 1 mechanics and toilet-ending assertions from the
deterministic project data. The visual review pack is for human approval and
does not claim 100/100 by itself. Engine ROM proof is a scaffold/runtime proof,
not full-game proof. FXPAK copy proof remains blocked until a real volume path
is approved.

SNES Studio now separates the fast synthetic benchmark from the real output
benchmark. The synthetic ladder checks local availability and expected role fit.
The real output benchmark asks each installed local candidate model to return
strict SNES Studio role JSON, saves raw outputs under
`.artifacts/snes-real-output-model-benchmark/`, scores JSON validity, patch
safety, role-signal coverage, asset/hardware specificity, latency, and optional
GPT 5.5 judge feedback. Local GLM-5.2 must pass both `/v1/models` discovery and
a minimal decode probe before it is benchmarkable; a server that only lists GLM
but returns `Compute error` is reported as decode-blocked and is not promoted.
Hosted GLM is never used. GPT 5.5 judging is allowed only when
`OPENCLAW_SNES_BENCHMARK_GPT_JUDGE=1` is set, and it judges saved outputs rather
than generating the game content. Run it with:

```bash
OPENCLAW_LOCAL_GLM52_BASE_URL=http://127.0.0.1:28080 \
pnpm snes:benchmark:models -- --mode output \
  --roles snes-game-director \
  --models ollama/openclaw-control-qwen25-32b:latest,ollama/openclaw-control-qwen36-27b:latest,local-glm-5.2-2bit \
  --rounds 3 --judge none --no-download --timeout 240 --max-output-tokens 900 --json

# Optional hosted judge add-on, only after explicit approval to send benchmark outputs to GPT 5.5:
OPENCLAW_SNES_BENCHMARK_GPT_JUDGE=1 pnpm snes:benchmark:models -- --mode output \
  --judge gpt-5.5 --no-download --timeout 900 --json
```

A model is not recommended unless it beats the current role default by at least
five mean points across all rounds with no blocked, invalid JSON, or fail runs.
The real benchmark also writes
`.artifacts/snes-real-output-model-benchmark/latest-summary.md` for a compact
side-by-side report. To diagnose GLM itself without running the full benchmark,
use:

```bash
pnpm glm52:runtime -- probe --json
```

That writes `.artifacts/glm52-local-runtime/latest.json` with the llama.cpp
endpoint, model id, decode blocker, request hash, memory snapshot, and repair
context. To restart GLM safely and try bounded local launch profiles, run:

```bash
pnpm glm52:runtime -- repair --json
pnpm glm52:runtime -- restart --profile metal-agent-8k --startup-timeout 900 --timeout 60 --json
```

The repair command only stops a process on the GLM port when the port owner is
`llama-server`; it refuses to kill unrelated processes. It then tries
`metal-low`, `metal-no-mmap`, and `cpu-safe` profiles in order, stopping after
the first successful decode probe. Metal profiles keep Flash Attention enabled
when using q8 KV cache because llama.cpp rejects quantized V cache without it.
The OpenClaw agent proof needs the explicit `metal-agent-8k` profile; the older
4096-token route can decode but overflows on the SNES hardware-QA prompt.

When a local GLM-5.2 run wins a role, make it a real OpenClaw model route before
expecting SNES Studio agents to use it:

```bash
pnpm glm52:runtime -- register-provider --context 8192 --max-output-tokens 256 --json
pnpm glm52:runtime -- promote-winners --agent snes-hardware-qa --json
pnpm openclaw gateway restart
pnpm glm52:runtime -- agent-proof --agent snes-hardware-qa --timeout 600 --json
pnpm glm52:runtime -- status --agent snes-hardware-qa --json
```

`register-provider` adds a local-only OpenAI-compatible provider named
`local-glm52` pointed at the loopback llama.cpp server. `promote-winners` reads
the latest real output benchmark and updates only roles where
`local-glm-5.2-2bit` is a clean benchmark winner; the promoted agent keeps the
previous local worker as fallback. `agent-proof` runs an actual OpenClaw agent
turn through `local-glm52/...` and fails closed unless the reply contains strict
SNES Studio hardware QA JSON with safe patch paths. `status` checks runtime
decode, provider registration, benchmark recommendation, agent promotion, and
agent proof in one receipt.

### Durable GLM Production Loop

For long Stanski's World production work, SNES Studio does not send GLM one giant
prompt. OpenClaw owns the production memory and asks local GLM-5.2 to complete
one milestone at a time. The loop persists progress in
`.artifacts/stanskis-world/production/`:

- `backlog.json` lists the graphics and gameplay milestones.
- `state.json` records the current milestone, completed milestones, blocked
  milestone, human visual grade, last good build, and last executable QA receipt.
- `memory-cards.json` keeps compact locked decisions and QA proof from passed
  milestones.
- `decision-log.json` records every status, patch, pass, fail, and blocker.
- `latest-summary.md` is the dashboard-readable handoff.
- `production-policy.json` records the local-only policy: local GLM required,
  hosted GLM disabled, routine GPT 5.5 disabled, executable QA required, and
  remote proof required before publishing.
- `control.json` and `worker.lock` provide pause/resume/cancel and double-run
  protection.
- `latest-worker-receipt.md` summarizes the most recent stop reason, blocker,
  next action, model use, and QA receipt.

Run the loop one milestone at a time by default:

```bash
pnpm stanski:produce -- --mode status --json
pnpm stanski:produce -- --mode split-next --json
pnpm stanski:produce -- --mode continue --max-milestones 1 --json
pnpm stanski:produce -- --mode retry-blocked --json
pnpm stanski:produce -- --mode auto --until blocked --max-runtime-minutes 30 --json
pnpm stanski:produce -- --mode pause --json
pnpm stanski:produce -- --mode resume --json
pnpm stanski:produce -- --mode cancel --json
```

Each milestone call builds a compact packet containing only the next milestone,
the current visual grade, relevant memory cards, the allowed patch schema, and
things that must not break. GLM must return strict JSON with `localGlmOnly: true`
and `hostedGlmUsed: false`. Markdown, raw HTML, raw JavaScript, wrong milestone
ids, wrong patch types, or hosted-provider flags fail closed. OpenClaw applies
the accepted patch deterministically, rebuilds the playable artifact, runs the
executable smoke gate, writes a milestone receipt, creates a memory card, and
then selects the next milestone.

Large asset milestones are split before GLM is asked for a giant response. For
example, `G07 Cleveland master tileset` becomes `G07a` through `G07e`, each with
10-25 concrete tile or integration requirements. The bounded `auto` mode holds a
recoverable worker lock, checks pause/cancel between milestones, retries GLM once
for invalid JSON or timeouts, and stops cleanly on blockers instead of running as
a persistent daemon.

The dashboard exposes the same loop with **Load Production Status**, **Start
Bounded Auto**, **Run One Milestone**, **Split Next**, **Retry Blocked
Milestone**, **Pause**, **Resume**, and **Cancel**. It also surfaces the current
milestone, completed count, GLM/GPT policy, worker lock heartbeat, last GLM patch
path, and last QA receipt path. Routine milestone execution does not call GPT
5.5. GPT 5.5 is reserved for low-reasoning QA summaries or repair briefs after
failures, and high-reasoning use is reserved for repeated blockers, architecture
changes, major design conflicts, or final production visual approval.

The dashboard also exposes a **Run Live Production Check** route. It sends three
staged Gateway `agent` jobs: GPT 5.5 Game Director, OpenClaw Game Team, deterministic validation, and GPT 5.5
Quality Gate. The GPT 5.5 stages request the configured `openai/gpt-5.5` model, OpenClaw
worker stages use the local OpenClaw agent lane, and SNES Studio waits with
`agent.wait` before reading the final `chat.history` response. The route is only
marked verified when every stage returns approval-gated JSON through Gateway. A
local deterministic draft is still available when live agents are not connected,
but it is labeled as fallback work rather than live GPT 5.5/OpenClaw proof.

Dashboard live checks do **not** require FXPAK hardware or the
`OPENCLAW_SNES_STUDIO_LIVE_AGENT_E2E` flag. They require a connected,
authenticated Dashboard Gateway session that can call `agent`, `agent.wait`, and
`chat.history`. The env flag is only for automated smoke/E2E runs so test lanes
do not accidentally spend GPT 5.5/OpenClaw model time. If the dashboard shows a
401 or disconnected Gateway, fix Dashboard auth or reconnect the Gateway first;
mounting a flash cart will not fix live AI.

For the safest authenticated launch, run:

```bash
openclaw dashboard --no-open --path /snes-studio
```

Open the copied URL. The SNES Studio **Connection Doctor** then reports whether
the page loaded, the Gateway WebSocket connected, the browser is authenticated,
and live agents can be checked. If it says `AUTH_TOKEN_MISSING`,
`AUTH_TOKEN_MISMATCH`, or "Dashboard auth missing or expired", reopen the copied
URL or paste the gateway token in Control UI settings before testing live agents.

SNES Studio checks the live AI team setup automatically when the Dashboard
Gateway is ready, but the automatic check does **not** spend model calls. The
GPT 5.5-Directed Team Status card reports **Live proof pending**, **Live OpenClaw
ready**, **Checking live OpenClaw**, or **Live OpenClaw unavailable**. Before
sending role work, the dashboard inspects `agents.list`, checks
`agents.runtime.status`, and safely creates missing SNES Studio OpenClaw worker
agents with `agents.create` when Gateway permissions allow it. **Check Again**
reruns the same fast setup check.

The status check covers role-specific Gateway sessions for GPT 5.5 Game Director,
OpenClaw Game Director, OpenClaw Level Designer, OpenClaw Gameplay Designer,
OpenClaw Art and Audio, OpenClaw Hardware QA, and GPT 5.5 Quality Gate. GPT 5.5 roles
request `openai/gpt-5.5`; OpenClaw worker roles target explicit worker agents
such as `snes-game-director` and `snes-level-designer`, and are the only roles
that fill creative text boxes. The expensive model-backed proof runs only when
the user chooses **Run Live Production Check** or explicitly starts a live build.
That proof runs stages sequentially with a longer timeout so cold-started local
models do not cause seven simultaneous 30-second failures. If live proof is
pending or unavailable, **Make My Game** uses the local deterministic
fallback and shows that receipt instead of pretending live agents were used.

## Classic Platformer Graphics

The default visual preset is **Classic Colorful SNES Platformer**: bright
original grassland tiles, chunky readable platforms, expressive enemies,
sparkling rewards, simple parallax-style skies, and 2-4 frame sprite recipes.
The preset is data-first: it carries concrete 16x16 tile specs, sprite frame
specs, palette indexes, music pattern specs, and sound-effect event mappings so
OpenClaw workers produce usable assets instead of vague mood-only notes.

When a prompt asks for "Super Mario World graphics," SNES Studio maps that to
the original preset and shows that it is using original SNES-safe art inspired by
classic platformer readability. It does not copy Nintendo tiles, sprites, music,
names, logos, or characters. Licensed assets are only used when the user imports
their own authorized files.

For Stanski Level 1, the clean-room Cleveland recovery target specifically
requires Terminal Tower, Key Tower, 200 Public Square, a Cuyahoga bridge truss,
and Lake Erie to be recognizable in the background. Downloading or copying Super
Mario World code, ROM data, sprites, tiles, maps, palettes, music, or assembly is
not allowed, even for personal-use builds.

The playtest canvas uses the active graphics preset immediately, and the preview
SNES game-file manifest records the preset, provenance, palette budget, tile
budget, sprite budget, and style warnings. Expert Studio exposes the exact
palette, level-square, moving-thing, memory, and checksum proof while the guided
builder keeps the beginner language simple.

The **AI Gap Filler** watches for missing pieces:

- Missing hero, goal, enemies, rewards, music, save memory, or ending.
- Empty or incomplete levels.
- Playability and export readiness blockers.

**Fill Missing Pieces** applies deterministic local fixes with undo, and locked
parts are preserved when the user marks story, levels, cast, rules, music, or
export settings as locked.

## Prompt-First Creation

There is one main game prompt, plus contextual prompts where they are useful.

- No selection: the prompt creates or changes the whole game or current level.
- Selected hero: the prompt changes hero movement or placement.
- Selected enemy: the prompt changes speed, patrol, behavior, or placement.
- Selected item: the prompt changes the pickup purpose or placement.
- Selected emulator area: the prompt can add coins, paint danger, add a door,
  remove things, or make a jump easier only inside that selected screen region.
- **Make Things**: prompts create custom heroes, enemies, items, powerups,
  blocks, doors, goals, hazards, music ideas, and new levels.

Every AI action records what changed, who did the work, what stayed safe, what
gaps remain, and what to test next. OpenClaw is the visible creative filler for
text boxes and game parts. GPT 5.5 appears as game director, critic, problem solver, and approval gate,
not as the normal text-box filler. Content changes can apply instantly with undo.
Code, runtime, and export changes still require approval through the agent patch
flow.

When a live Gateway agent session is unavailable, **Run Local Agent Proof** uses
the same OpenClaw/Codex approval-gated patch contract with the deterministic
local runner. That proves prompts can still create an editable review patch
instead of appearing inert. **Run Live Agent Proof** checks one connected
preview task. **Run Live Production Check** checks the full staged
GPT 5.5/OpenClaw/validation/GPT 5.5 loop and is not marked passed until each stage returns
editable patch JSON.

## Playtest

The browser playtest is the beginner proof surface. It now runs through the
shared platformer runtime contract used by the dashboard and export manifest.
The live loop targets the SNES NTSC cadence of 60.0988 frames per second with a
fixed-step runtime, then draws the scene to a 256x224 pixel canvas using
nearest-neighbor scaling and simple pixel-style hero, enemy, item, door, and
goal sprites.

It supports:

- A 60 Hz runtime playtest canvas with readable pixel-style hero, enemy, item,
  door, and goal sprites plus compact editable handles.
- Continuous live play: press **Start Test**, then hold keyboard keys or
  controller buttons to move and jump until pausing or restarting.
- Drag-select an empty area of the game screen, type a prompt, and apply the
  change to that part of the level.
- Click visible ground, danger, water, or empty space to snap the highlighted
  area to that part of the level before prompting AI.
- Highlighted-area prompts understand common add, remove, and change intents,
  such as "add coins here," "remove enemies in this area," "make this safe
  ground," "make this a gap," "add a secret door," and "paint this as danger."
- When the highlight came from clicking an existing ground, danger, or water
  chunk, dragging the highlighted chunk moves that level piece itself; prompts
  like "move this ground down" also move the actual level piece.
- The same terrain chunks can be resized directly with the corner handle or with
  prompts such as "make this platform longer" or "make this ground shorter."
- Drag the highlighted selection itself to move it, or drag its corner handle to
  resize it before asking AI to add, remove, or change content there.
- Click and hold any visible hero, enemy, item, door, or goal handle to move it
  directly on the play surface; releasing hot-reloads the runtime so the new
  position is immediately testable.
- In **Play & Change**, the **Ask AI** bar appears before the emulator canvas so
  prompt-based editing stays the first obvious action.
- Once an area is selected, quick actions can immediately add coins, add an
  enemy, add a key, make the jump easier, make safe ground, make danger, or
  remove things inside that rectangle.
- The selected-area prompt bar also shows plain "Try asking" examples, such as
  "Make this jump easier," "Add a hidden key here," and "Remove only enemies
  here," so users can learn the prompt loop by playing with the controls.
- Use **Preview Area Change** when you want to check an AI edit before it changes
  the game. The preview card shows what will change, offers **Apply Preview**,
  and lets you cancel without touching the playtest.
- The play surface keeps game objects as compact glowing edit handles by
  default, with labels revealed on hover, focus, or selection so the game stays
  readable while editing remains discoverable.
- Obvious **Run Right**, **Jump**, and **Show It Working** actions that explain
  what changed after each test input.
- Left/right movement.
- Jump and gravity.
- Ground, gaps, and hazard behavior.
- Enemy patrol/contact.
- Item pickup.
- Score, health, lives, win/loss state.
- Goal reach.
- Restart and test controls.
- A deterministic game-quality report that hard-gates AI approval on finishable
  levels, reachable jumps, first-screen fairness, reachable rewards, visible
  goal/path, reasonable enemy density, first-30-seconds pacing, and export
  constraints.

Every prompt or drag/drop edit recompiles the runtime contract and hot-reloads
the playtest. When state can be preserved safely, the hero stays in the current
test. Otherwise the level restarts with a visible message.
The production card shows the actual planner route, worker route, QA route,
quality score, playtest status, and whether live GPT 5.5/Codex cost was used. The
**Improve Game Quality** action repairs deterministic quality blockers before
the dashboard suggests export.

Expert Details show the runtime hash, target frame cadence, drawn FPS, slow-frame
counter, deterministic browser replay proof, and emulator replay parity status.
The replay parity report ties together the exported game-file runtime manifest,
the browser input replay, the expected emulator state hash, the selected emulator
boot command, screenshot proof, and an emulator state dump when one exists. The
downloadable proof package includes the exact replay input frames and operator
instructions needed to reproduce the browser run in an emulator. When an
emulator is selected in Expert Studio, SNES Studio also prepares a downloadable
run script that boots the exported game file with the same runtime hash, replay
frame count, and expected final state hash. Real ROM/emulator parity is only
claimed after the emulator state hash matches the browser replay hash; otherwise
SNES Studio keeps the exact blocker visible.

Keyboard controls work from the playtest card: hold arrow keys or WASD to move,
Space jumps, Enter starts running, Escape pauses, and R restarts.

## Drag And Drop

Drag/drop is secondary to prompting and used where it helps:

- The **Things Shelf** can add hero, enemy, item, powerup, platform, hazard,
  door, goal, and coin-trail pieces.
- Existing visible game things can be dragged on the playtest stage.
- Direct pointer dragging works inside the emulator-like canvas, so users do not
  need to understand browser drag/drop mechanics before moving a game thing.
- The selected thing panel exposes direct controls for simple movement and
  behavior tuning.
- The highlighted screen-area tool supports both prompts and one-click quick
  edits, so add/change/remove actions are available without searching panels.
- The highlighted screen-area tool can also be moved and resized directly on the
  play surface before applying AI changes.
- Terrain selected with one click acts like a movable level piece: drag it or
  prompt AI to move it, then the 60 Hz playtest hot-reloads immediately.
- Terrain selected with one click can also be stretched or shrunk directly, so
  platforms can be tuned without opening the advanced level editor.
- Selected-area removal can target matching game things, such as enemies or
  rewards, without wiping out the whole level unless the prompt asks for a gap,
  empty space, or clearing everything.
- A simple click on existing ground, danger, water, or empty space selects that
  part of the level, keeping changes discoverable without manual rectangle drawing.

## Beginner Language

Beginner-facing UI avoids expert wording where possible:

- **SNES game file** instead of ROM.
- **Save memory** instead of SRAM.
- **Flash cart** instead of FXPAK PRO.
- **Level square** instead of tile.
- **Where the player bumps** instead of collision.

Unavoidable expert terms use question-mark help with plain definitions,
why the term matters, and whether the user needs to care now.

## Expert Studio

Expert Studio preserves professional SNES control without crowding the guided
flow. It includes:

- Full project safety and recovery.
- Advanced AI stage and patch review.
- Hardware budgets.
- Build console.
- Asset pipeline.
- Emulator proof.
- Flash cart export plan.
- Generated object audit.

Hardware constraints remain enforced:

- LoROM profile.
- Save memory/SRAM plan.
- Flash cart/FXPAK PRO package path.
- 128 GB FAT32 microSD target.
- SuperFX profile state.
- VRAM, CGRAM, OAM, ARAM/SPC700, banks, and checksum proof.

## Verification

The guided surface is covered by `ui/src/ui/views/snes-studio.test.ts`.
The live smoke flow is `scripts/dev/control-ui-snes-studio-smoke.ts`.

The covered flow verifies:

- The default route renders the story-first guided builder, not the dense tool rail.
- One prompt creates a GPT 5.5 blueprint when the live route is approved, or a local
  fallback blueprint, then OpenClaw fills the story map, level chapters, cast,
  rules, and playable platformer draft.
- GPT 5.5 Quality Gate can fail weak output, request OpenClaw corrections, and
  approve only after checks pass when that approved route runs.
- The AI Gap Filler reports and fills missing game parts without hiding the result.
- The playtest stage shows hero, enemies, items, score, health, and state.
- Prompt-created things appear in the Things Shelf and playtest.
- Clicking a visible thing opens direct editing.
- Selected-thing prompts only change the selected object.
- Selected-area prompts can add, remove matching things, and change highlighted
  terrain with natural language.
- Beginner export uses plain language.
- Expert Studio still exposes the hardware proof path.
- Local OpenClaw proof returns an approval-gated editable patch even when
  live Gateway proof is not configured.
- Emulator replay parity is surfaced in the playtest HUD, export proof panel, and
  downloadable proof report instead of being hidden behind logs.

## Visual Quality And Revision Gates

SNES Studio treats graphics quality as a build gate. Drafts must score at least
`50/100`, requested high-quality drafts must meet the requested target, and
production art needs deterministic metrics plus human visual approval unless GPT
5.5 visual review is separately approved.
The **Art Director / Visual QA** gate is separate from general QA: it blocks
rectangle/placeholder art, spec-only graphics, missing sprite sheets, too few
tile variants, missing palette ramps, missing background/parallax layers, and
missing review proof. Human visual grade overrides synthetic scoring; if the
human grade is below target, production remains blocked even when machine scores
look good. For a `100/100` target, the gate requires production-approved assets,
40 approved hero animation frames, at least 96 production tileset variants,
background depth proof, review artifacts, in-game screenshot proof, and human
approval. Draft-generated compiler output is reviewable evidence, not approval. The executable
quality receipt should prove non-rectangle hero sprites, multiple animation
frames, palette ramps, foreground/background separation, concrete landmark
layers, and visible item/enemy/goal silhouettes.

For revisions, GPT 5.5 writes the diagnosis and minimal repair brief, local
OpenClaw or local GLM workers return structured patch JSON only, deterministic
code applies the patch, browser QA runs, and GPT 5.5 approves only after machine
proof passes. Text checklists and model self-reviews are advisory; they cannot
approve a game.

Playable preview links follow the same proof chain. Publish the canonical remote
Control UI or Tailscale route only after loopback and remote HTTP probes prove
the game route serves the playable artifact instead of the Control UI shell. The
handoff should include the playable link, executable QA receipt, and patch/model
receipt.

Local media generation is fail-closed. If a local ComfyUI image workflow or a
local video workflow is unavailable, the title image or title animation status is
`blocked` with the exact local blocker. Hosted media providers are not used for
local-only SNES game assets unless the operator explicitly changes scope.

## Production SNES Studio Gates

SNES Studio now treats the browser game as a fast preview, not production proof.
The reusable Production SNES Studio cockpit separates five beginner modes:
**Create**, **Edit**, **Art Lab**, **Playtest**, and **Ship**.

Production completion is blocked until all required proof surfaces pass:

- Browser preview and deterministic playtest.
- Real asset pipeline with traced sprite, item, tileset, and background assets.
- Human or approved GPT 5.5 visual approval for the requested target score.
- `.sfc` ROM build receipt.
- Emulator boot proof receipt.
- FXPAK PRO package dry-run.
- Manual original-SNES hardware proof.

SNES Studio proof tiers are intentionally separate. A DOM/static dashboard check
can prove that the built bundle contains the SNES Mastery card and blocker
language, but it is labeled `dom-static` and `productionBrowserEquivalent:
false`. It cannot close browser-visible proof. Browser-visible proof requires a
verified Playwright Chromium launch, route load, and smoke receipt. Emulator
launch proof also stays separate from emulator screenshot proof and runtime
signature proof; a launch-only receipt cannot close screenshot, timing, or
runtime-asset milestones.

The **Toolchain Doctor** is read-only. It reports missing or available SNES tools
without installing anything: PVSnesLib, SuperFamiconv, Pixelorama, optional
Aseprite CLI, LDtk, optional Tiled, Mesen or bsnes, SuperFamicheck, BRRtools, and
FXPAK/SD2SNES-style FAT32 media. Missing tools are shown as actionable blockers,
not hidden behind a green dashboard state.

Stanski's World remains the canary project. Generic SNES Game Builder code must
load Stanski through the same manifest, asset registry, toolchain, visual, ROM,
emulator, and FXPAK gates used by every future game.

## Local Model Benchmark And Live Proof Gates

Run the local-only SNES model benchmark without downloads:

```bash
pnpm snes:benchmark:models -- --no-download --timeout 180
```

The benchmark writes `.artifacts/snes-local-model-benchmark/latest.json` and a
timestamped `report.json`. It must not download models or use hosted providers.
Unavailable models, including GLM-5.2 unless already installed locally, are
reported as skipped blockers.
For real output comparison, run the output benchmark with `--rounds 3`. SNES
Studio keeps `promotionApplied: false`; the report provides role-specific
recommendations for review instead of changing worker defaults automatically.

Full live GPT 5.5 proof is intentionally manual unless automated E2E is enabled.
To complete it from the authenticated dashboard session:

1. Run `openclaw dashboard --no-open --path /snes-studio`.
2. Open the copied URL.
3. Confirm the Connection Doctor says the page loaded, Gateway is connected, and
   auth is OK.
4. Click **Check Again**.
5. Click **Run Live Production Check**.
6. Confirm GPT 5.5 approval appears only if the live route actually ran.
7. Build a game.
8. Run **Improve Game Quality**.
9. Export the `.sfc` preview and emulator proof bundle.

Do not claim full live completion if the dashboard is using local fallback or if
the automated smoke only reports `OPENCLAW_SNES_STUDIO_LIVE_AGENT_E2E=1`.
Full automated live proof must click **Run Live Production Check** and see the
dashboard success receipt that GPT 5.5 planning, OpenClaw building, and GPT 5.5
approval stages returned approval-gated JSON through Gateway.

Local GLM-5.2 remains a local-only experimental lane. SNES Studio may benchmark
`local-glm-5.2-2bit` only when a local llama.cpp OpenAI-compatible server reports
a GLM-5.2 model and a minimal `/v1/chat/completions` decode probe succeeds. Do
not use hosted GLM for SNES Studio, and do not promote GLM to a worker default
unless the local benchmark report shows it wins that role with no blockers.

Maintainers can run the same authenticated browser proof without printing the
tokenized URL:

```bash
pnpm openclaw dashboard --no-open --path /snes-studio
pnpm ui:smoke:snes-studio --from-clipboard
```

The smoke reads the copied URL from the macOS clipboard and redacts token
fragments in `summary.json`, `latest.json`, and terminal output.

## Generic SNES Mastery Proof Chain

The reusable SNES Studio capability ledger is separate from any one game. The current generic mastery gate is verified with:

```bash
pnpm snes:mastery status --json
pnpm snes:mastery next --json
pnpm snes:mastery:receipts
node .artifacts/snes-game-builder-reference/scripts/validate-reference-corpus.mjs
node .artifacts/snes-game-builder-reference/scripts/validate-generic-scope.mjs
```

A complete generic ledger means the reusable proof system is green; it does not mean a specific game has production art, full route design, FXPAK copy proof, or original SNES hardware proof. SNES Studio keeps these proof surfaces separate: browser-visible dashboard proof, emulator screenshot/runtime proof, budget enforcement, runtime asset truth, FXPAK package dry-run, removable-media copy proof, and original hardware proof.

Expert Studio exposes local proof actions for the generic chain: mastery refresh, browser proof, emulator proof, budget proof, runtime asset truth, FXPAK dry-run validation, and the generic project generator gate. These actions run local scripts, write local receipts, and never write to FXPAK/removable media. Browser proof may require a working Playwright Chromium install; emulator proof may require a working local emulator adapter or a disposable local container. If local container infrastructure is broken, the blocker must be recorded separately instead of downgrading generic proof status.

The default artifact policy is local-first: keep bulky `.artifacts/**` proof outputs local unless a release process explicitly requires committing a small reproducible receipt or script. Commit source, tests, and docs needed to reproduce the proof; do not commit commercial SNES ROMs, copied commercial code/assets, screenshots from commercial games, FXPAK media contents, or secret/key files.

For a new game, use **Create Blank SNES Project** to create a clean generic `openclaw-snes-project-package`. Project creation is only a package-creation receipt. The project still must pass ROM build, SuperFamicheck, budget, runtime asset truth, emulator screenshot, FXPAK dry-run, and any game-specific human approval gates before production claims are allowed.

Stanski's World remains a separate canary project with its own blockers. Generic SNES mastery can be 100% while Stanski production remains blocked by visual grade, missing human 100/100 approval, missing source-photo preservation, missing FXPAK copy proof, and missing original SNES hardware proof.
