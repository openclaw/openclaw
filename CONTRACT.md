# ZekeBot Repository Contract

ZekeBot is the Zeke-operated fork of OpenClaw. Upstream remains `openclaw/openclaw`; this fork lives at `openzeke/zekebot`.

## Authority

- Preserve upstream OpenClaw MIT license and attribution.
- Keep Zeke-specific governance in this file, `AGENTS.md`, `CONTRIBUTING.md`, `manifest.json`, and `LICENSE-ZEKEBOT-NOTICE.md`.
- ZekeFlow remains the authority for Zeke tool execution, audit, approvals, context policy, and durable state.
- ZekeBot/OpenClaw may advertise native model-facing tools, but those adapters must call ZekeFlow authority APIs instead of writing Zeke state directly.

## Boundaries

- Do not add direct SQLite, Cognee, pending proposal, event bus, or signal writes from ZekeBot plugin/tool code.
- Do not expose `create_signal` as a model-facing tool. Conversational signal flow uses `propose_signal` plus governed approval.
- Profile exposure must be explicit. Sprout, Rambo, and external-client catalogs are separate contracts.
- Native OpenClaw runtime primitives such as bounded `sessions_spawn` stay separate from Zeke capability tools.
- Fork image publishing must use `openzeke/zekebot` GHCR packages and avoid moving `:latest` except through the promotion gate.

## Upstream Merge Policy

- Fetch from `upstream main`; never push to upstream.
- Before merging or cherry-picking upstream, identify touched contracts: native tool/plugin ABI, profile visibility, gateway/hook ABI, Dockerfiles, workflows, and image publishing.
- Run the narrowest relevant tests first, then the story-required gates.
- Record upstream base SHA, merge/cherry-pick SHA, surprises, and rollback path in the active OCL-FORK checkpoint.

## S1 Baseline

- Fork base: `openclaw/openclaw@58f2d17e9e05f76c382c47e8a533af3595df0231`.
- Fork visibility at creation: public GitHub fork.
- License: MIT, preserved from upstream `LICENSE`.
