---
name: snes-game-creator
description: Use for SNES Studio worker-agent tasks that create, repair, or review SNES, Super Nintendo-style, 16-bit side-scrolling platformer games, including game blueprints, local OpenClaw/GLM structured patch JSON, executable playtest QA, visual-quality gates, and remote playable-link handoff.
---

# SNES Game Creator

Use for SNES Studio worker-agent tasks that create, repair, or review a side-scrolling Super Nintendo platformer. For Metro Bomberman, this skill is the parent orchestrator for all game modifications, builds, patches, emulator QA, FXPAK readiness checks, and milestone status updates.

## Required Output

Every response must include:

- `surface`: exact game surface changed, such as story, level, gameplay, art, audio, hardware, QA, or publish-link.
- `content`: concrete playable content, not broad mood text.
- `constraints`: SNES/FXPAK constraints preserved.
- `playtestHypothesis`: what should be true when the level is tested.
- `riskOrBlocker`: the highest-risk issue, or `none`.
- `patchReceipt`: what JSON patch or structured receipt should be reviewed before apply.

## Role Contracts

- Game Director: define premise, core loop, stakes, fun hook, target player emotion, ending, art-quality rubric, and build receipt.
- Level Designer: define finishable route, reachable jumps, fair enemy placement, reward pacing, secrets, midpoint/checkpoint, and visible goal.
- Gameplay Designer: define movement constants, enemy behavior, item effects, hazards, lives/death behavior, crouch/projectile origins, and repair instructions.
- Art/Audio: define concrete 16x16 tile ids, sprite frames, palette indexes, animation beats, landmark/background layers, music patterns, and SFX events.
- Hardware QA: verify ROM, SRAM, VRAM, CGRAM, ARAM, FXPAK PRO FAT32, SuperFX, checksum, and export blockers.
- QA Gate: executable proof only. Text checklists can critique but cannot approve.

## Quality Bar

Do not approve vague output. A good game draft must be finishable, understandable in the first screen, fair to a beginner, rewarding within the first 30 seconds, and export-safe for the configured SNES hardware profile.

Visual quality is a gate, not a preference:

- Draft visual quality must be at least `50/100`.
- Requested high-quality drafts must meet the requested score, such as `70/100`.
- Production visual quality needs deterministic metrics plus GPT 5.5 or human visual approval.
- Art output must include non-rectangle sprite silhouettes, multiple animation frames, palette ramps, foreground/background separation, and concrete landmark/tile/sprite data.

## Legal SNES Reference Corpus

When the user asks to download SNES games/code for inspiration, improve Codex/OpenClaw SNES coding skill, or build FXPAK Pro-compatible reference material, read `references/legal-snes-reference-corpus.md` before acting. The safe local root is `.artifacts/snes-game-builder-reference/`. Commercial ROMs, commercial source leaks, reverse-engineered commercial disassemblies, and copied commercial art/audio/code are blocked even for personal-use requests. Use permissive SDK examples, hardware docs, and clean-room katas instead.

## Revision Workflow

Use this loop for game creation and repairs:

1. GPT 5.5 high-reasoning writes the initial blueprint, art rubric, mechanics contract, and QA requirements.
2. Local OpenClaw/GLM workers produce structured patch JSON only.
3. Deterministic code applies patches; workers must not emit raw runtime HTML/JS.
4. Executable browser QA runs controls, replay, mechanics, visual metrics, route/link proof, and export blockers.
5. If QA fails, GPT 5.5 diagnoses the evidence and writes a minimal repair brief.
6. Local OpenClaw/GLM workers apply the repair as structured patch JSON.
7. GPT 5.5 gives final approval only after machine proof passes.
8. Dashboard or chat links are delivered only after live route proof passes.

## Producer Orchestrator And GPT 5.5 Token Policy

The Producer Orchestrator owns the project manifest, milestone order, token policy, pass/fail decisions, and role receipts. Agents do not remember the project; the manifest and memory cards do.

Use GPT 5.5 only when it clearly improves quality:

- high reasoning: initial blueprint, repeated blocker diagnosis, major design conflict, production visual approval, final shipping approval;
- low reasoning: concise QA summary or obvious repair brief;
- never for routine local milestone patch generation.

Routine local milestones should record `gpt55Used: false`, `reasoningLevel: none`, why local OpenClaw/GLM was used, and what GPT 5.5 cost was avoided. Local OpenClaw/GLM workers implement scoped patches from compact packets.

Every agent handoff must include:

- surface changed;
- patch path or hash;
- assumptions;
- risks;
- playtest hypothesis;
- QA evidence required;
- next role;
- blocker, or `none`;
- GPT 5.5 use and reasoning level;
- local model used, or `none`.

## Art Director / Visual QA

General QA cannot approve production graphics. The Art Director / Visual QA gate must reject rectangle/placeholder art, spec-only graphics, missing real sprite sheets, too few tile variants, missing palette ramps, missing background/parallax layers, and missing screenshot proof.

Human visual grade overrides synthetic scoring. If the human grade is below target, production remains blocked even if the model or machine score claims the visuals are good.

## Durable GLM Production Loop

For long game upgrades, do not ask GLM to remember the whole project. Use the Stanski/SNES production-loop pattern:

1. OpenClaw owns the backlog, `state.json`, `memory-cards.json`, `decision-log.json`, and latest summary.
2. GLM receives exactly one compact milestone packet: current milestone, current grade, relevant memory cards, allowed schema, and do-not-break constraints.
3. GLM returns strict JSON only with `localGlmOnly: true`, `hostedGlmUsed: false`, the exact `milestoneId`, and the expected patch type.
4. Deterministic code validates, applies, rebuilds, runs executable QA, writes a receipt, creates a memory card, and then selects the next milestone.
5. Use `pnpm stanski:produce -- --mode status --json`, `pnpm stanski:produce -- --mode continue --max-milestones 1 --json`, or `pnpm stanski:produce -- --mode retry-blocked --json` for Stanski's World.
6. Routine milestone execution should not call GPT 5.5. Use low-reasoning GPT 5.5 only for concise QA summaries or obvious repair briefs, and high reasoning only for repeated blockers, architecture changes, major design conflicts, or final production visual approval.

Core rule: GLM is stateless; OpenClaw persists progress and chooses the next milestone.

## Project Command Center Workflow

For long-running SNES game creation, use the Project Command Center (PCC) as the durable orchestrator. Read these references when the task needs the full production workflow:

- `references/production-orchestration.md` for PCC state, completion runner, and repair loop.
- `references/agent-routing.md` for agent roles, model defaults, and parallelism rules.
- `references/proof-gates.md` for milestone judging and proof separation.
- `references/art-quality-rubric.md` for legal classic-SNES visual quality criteria.
- `references/prompt-to-rom-workflow.md` for the end-to-end prompt-to-ROM process.

Use `pnpm snes:team -- --mode status --project <id> --json` to inspect PCC state, `--mode next` to pick the next safe milestone, and `--mode validate` before claiming completion. PCC v2 adds deterministic overnight runner scaffolding, approval queues, pause/resume/cancel, and worker-packet export. It still does not automatically spend hosted model calls or run live worker agents without approval.

## SNES Studio Heavy-Lifting Contract

For every nontrivial SNES Studio project, make OpenClaw own the repeatable work. Prefer project-local scripts and receipts over agent memory, broad prompts, or manual checklists.

Each active project should maintain these surfaces when applicable:

- milestone ledger with complete, incomplete, blocked, and superseded work;
- next-milestone router that returns the first incomplete milestone and required skill routing;
- source/reference preservation receipts for user-provided images;
- sprite/package validator for file existence, dimensions, palette/index mode, blank frames, duplicate frames when available, and deliberate negative fixtures;
- contact-sheet generator for changed sprites, backgrounds, title surfaces, and UI assets;
- visual-surface validator for title overlap, crop/nonblank checks, runtime screenshot visibility, and before/after comparisons;
- emulator regression gate for build, patch, header, FXPAK dry-run, scripted gameplay, screenshots, and WRAM checks when available;
- patch-only handoff gate that scans ZIP contents for `.sfc`, `.smc`, `.swc`, `.fig`, and `.rom`;
- QA dashboard that separates `available checks passed` from `production complete`.

Completion rules:

- Do not claim completion from a plan, prompt, contact sheet, static image, or runtime screenshot alone.
- Treat source preservation, contact-sheet proof, runtime visibility, gameplay behavior, full playthrough, and hardware proof as separate gates.
- If a required source image, mounted FXPAK volume, human approval, local model, emulator, or runtime route is unavailable, write a blocked receipt with the exact blocker.
- Routine milestones should use deterministic local scripts first. Use GPT 5.5 for initial blueprints, repeated blocker diagnosis, subjective visual approval summaries, or final production approval.

## Image Asset Delegation

When a user provides or requests an image for an SNES/16-bit game, use the `snes-16bit-image-assets` skill. This includes title portraits, character sprites, enemy sprites, item sprites, background layers, tilesets, and UI icons. Preserve the source image, convert it into a deterministic SNES-safe asset, request only local GLM-5.2 structured JSON patches, and require executable visual QA before claiming the asset is used.

For Metro Bomberman character repair work, also use the specialized character skills when they apply:

- `metro-tim-misney-boss-sprite` for the World 1 Tim Misney Bigaron boss surface.
- `metro-drew-carey-enemy-sprite` for Drew Carey as a normal World 1 enemy target.

The routing order is mandatory:

1. Start with `snes-game-creator` to identify the game milestone, gameplay constraints, build commands, patch policy, and QA gate.
2. Delegate source-image preservation and SNES-safe conversion to `snes-16bit-image-assets`.
3. Delegate Metro-specific Tim/Drew frame mapping and sprite package rules to the matching character skill.
4. Return to `snes-game-creator` for integration, `make CONFIG=us`, patch regeneration, emulator proof, FXPAK dry-run, and milestone status updates.
5. Do not mark any Metro sprite milestone complete from an image/contact sheet alone; completion requires a rebuilt ROM and executable runtime proof unless the milestone is explicitly documentation-only.

## Remote Play Link Handoff

When publishing a playable preview for another device, including a MacBook on a different network:

- Use the canonical Tailscale/remote dashboard route, not a loopback-only link.
- Verify the route with `curl` or an equivalent HTTP probe before sending it.
- Verify `/game`, `/game/`, and `/game/index.html` variants when a static directory is served.
- Include links to the playable game, executable QA receipt, and model patch receipt.
- Never send the playable link until executable QA and remote route proof both pass.

## Local-Only Media And Model Policy

- Hosted GLM is forbidden for SNES Studio local-game content unless the user explicitly changes scope.
- Local GLM-5.2 may create creative patch JSON; deterministic code applies it.
- Local image/video generation must fail closed. If local ComfyUI or a local video workflow is unavailable, report `blocked` with the exact blocker instead of using a hosted provider.

## PCC v3 Multi-Agent Coordination

PCC v3 adds dispatch dry-runs, worker sandbox contracts, write-surface guards, patch application gates, local-only live worker dispatch, parallel scheduling metadata, model health routing, artifact cache metadata, reviewer receipts, conflict detection, compact memory cards, telemetry, dashboard snapshots, and legal clean-room prompt-to-ROM benchmark scaffolding. Hosted GLM, paid tools, commercial SNES material, FXPAK writes, push/PR, and human production visual approval remain approval-gated.

## PCC Real Local Model Execution

For approved PCC live work, use `--local-only --invoke-local-models` to call installed Ollama/OpenClaw models. A real worker receipt must show `modelInvoked: true`, local model metadata, strict JSON validation, `hostedGlmUsed: false`, and `gpt55Used: false`. Do not apply model output until the PCC patch gate and milestone judge pass.
