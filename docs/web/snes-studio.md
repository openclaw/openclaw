---
summary: "SNES Studio dashboard for AI-first side-scrolling platformer projects"
read_when:
  - You want to use or change the SNES Studio dashboard
  - You are working on AI-first creation, playable simulation, or hardware-aware export planning
title: "SNES Studio"
---

SNES Studio is a local-first Control UI dashboard for making Super Nintendo game
projects with a Codex-supervised OpenClaw Game Team.

The default experience is now an AI Arcade Builder for one beginner-friendly
game type first: story-driven side-scrolling platformers.

1. Describe the game.
2. Codex creates the blueprint, quality rubric, risk list, and OpenClaw role
   tasks.
3. OpenClaw fills the game plan, level chapters, cast, items, rules, save plan,
   and first playable level.
4. Codex reviews the result and approves playtest/export only when the checks
   pass.
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
- AI production team status: **Codex Architect**, **OpenClaw Game Team**, and
  **Codex Quality Review**.
- **Build With OpenClaw**.
- Starter prompt chips.
- Nothing else from the professional workbench unless **Expert Studio** is opened.

After AI makes the draft, the guided steps are **Idea**, **Game Plan**, **Build
Levels**, **Make Things**, **Play & Change**, and **Create Game File**.

## Game Plan And Gap Filling

The production loop now creates a full game draft rather than only a first level:

1. **Codex Architect** writes the game blueprint, quality rubric, risks, and
   role-agent task briefs.
2. **OpenClaw Game Team** fills the editable text boxes and game parts.
3. **Codex Quality Review** scores fun, clarity, first-level playability, rewards,
   SNES constraints, and export readiness.
4. **OpenClaw Game Team** applies required Codex corrections.
5. **Codex Quality Review** approves the draft for playtest or SNES game file.

The Game Plan contains the premise, world, hero goal, villain, conflict, ending,
tone, items, music mood, save plan, and plain gameplay rules. **Build Levels**
shows levels as chapters with a purpose, setting, challenge, reward, and goal.

Cost control is part of the contract. OpenClaw local workers handle normal
creative generation, text boxes, level edits, selected-object changes, and gap
filling. Codex is reserved for high-leverage gates: initial blueprint/rubric,
quality review, correction requests, export/build-fix review, and final approval.
Generic agent task helpers default to OpenClaw so new prompt surfaces do not
accidentally spend Codex calls.

The dashboard also exposes a **Run Live Production Check** route. It sends three
staged Gateway `agent` jobs: Codex Architect, OpenClaw Game Team, and Codex
Quality Review. The Codex stages request the configured Codex model, OpenClaw
worker stages use the local OpenClaw agent lane, and SNES Studio waits with
`agent.wait` before reading the final `chat.history` response. The route is only
marked verified when every stage returns approval-gated JSON through Gateway. A
local deterministic draft is still available when live agents are not connected,
but it is labeled as fallback work rather than live Codex/OpenClaw proof.

Dashboard live checks do **not** require FXPAK hardware or the
`OPENCLAW_SNES_STUDIO_LIVE_AGENT_E2E` flag. They require a connected,
authenticated Dashboard Gateway session that can call `agent`, `agent.wait`, and
`chat.history`. The env flag is only for automated smoke/E2E runs so test lanes
do not accidentally spend Codex/OpenClaw model time. If the dashboard shows a
401 or disconnected Gateway, fix Dashboard auth or reconnect the Gateway first;
mounting a flash cart will not fix live AI.

SNES Studio checks the live AI team setup automatically when the Dashboard
Gateway is ready, but the automatic check does **not** spend model calls. The
Live AI Team Status card reports **Live proof pending**, **Live OpenClaw
ready**, **Checking live OpenClaw**, or **Live OpenClaw unavailable**. Before
sending role work, the dashboard inspects `agents.list`, checks
`agents.runtime.status`, and safely creates missing SNES Studio OpenClaw worker
agents with `agents.create` when Gateway permissions allow it. **Check Again**
reruns the same fast setup check.

The status check covers role-specific Gateway sessions for Codex Architect,
OpenClaw Game Director, OpenClaw Level Designer, OpenClaw Gameplay Designer,
OpenClaw Art and Audio, OpenClaw Hardware QA, and Codex QA Gate. Codex roles
request `openai/gpt-5.5`; OpenClaw worker roles target explicit worker agents
such as `snes-game-director` and `snes-level-designer`, and are the only roles
that fill creative text boxes. The expensive model-backed proof runs only when
the user chooses **Run Live Production Check** or explicitly starts a live build.
That proof runs stages sequentially with a longer timeout so cold-started local
models do not cause seven simultaneous 30-second failures. If live proof is
pending or unavailable, **Build With OpenClaw** uses the local deterministic
fallback and shows that receipt instead of pretending live agents were used.

## Classic Platformer Graphics

The default visual preset is **Classic Colorful SNES Platformer**: bright
original grassland tiles, chunky readable platforms, expressive enemies,
sparkling rewards, simple parallax-style skies, and 2-4 frame sprite recipes.

When a prompt asks for "Super Mario World graphics," SNES Studio maps that to
the original preset and shows that it is using original SNES-safe art inspired by
classic platformer readability. It does not copy Nintendo tiles, sprites, music,
names, logos, or characters. Licensed assets are only used when the user imports
their own authorized files.

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
text boxes and game parts. Codex appears as architect, critic, and approval gate,
not as the normal text-box filler. Content changes can apply instantly with undo.
Code, runtime, and export changes still require approval through the agent patch
flow.

When a live Gateway agent session is unavailable, **Run Local Agent Proof** uses
the same OpenClaw/Codex approval-gated patch contract with the deterministic
local runner. That proves prompts can still create an editable review patch
instead of appearing inert. **Run Live Agent Proof** checks one connected
preview task. **Run Live Production Check** checks the full staged
Codex/OpenClaw/Codex loop and is not marked passed until each stage returns
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

Every prompt or drag/drop edit recompiles the runtime contract and hot-reloads
the playtest. When state can be preserved safely, the hero stays in the current
test. Otherwise the level restarts with a visible message.

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
- One prompt creates a Codex blueprint, OpenClaw-filled story map, level
  chapters, cast, rules, and playable platformer draft.
- Codex Quality Review can fail weak output, request OpenClaw corrections, and
  approve only after checks pass.
- The AI Gap Filler reports and fills missing game parts without hiding the result.
- The playtest stage shows hero, enemies, items, score, health, and state.
- Prompt-created things appear in the Things Shelf and playtest.
- Clicking a visible thing opens direct editing.
- Selected-thing prompts only change the selected object.
- Selected-area prompts can add, remove matching things, and change highlighted
  terrain with natural language.
- Beginner export uses plain language.
- Expert Studio still exposes the hardware proof path.
- Local OpenClaw/Codex proof returns an approval-gated editable patch even when
  live Gateway proof is not configured.
- Emulator replay parity is surfaced in the playtest HUD, export proof panel, and
  downloadable proof report instead of being hidden behind logs.
