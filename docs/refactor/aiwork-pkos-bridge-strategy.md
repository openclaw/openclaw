---
title: "AIWork PKOS Bridge Strategy"
sidebarTitle: "PKOS Bridge Strategy"
summary: "Customization and upgrade strategy for integrating PKOS and Workbench with OpenClaw"
---

# AIWork PKOS Bridge Strategy

This document records the current conclusions for customizing OpenClaw inside
AIWork without making upstream syncs expensive or risky.

## Why this document exists

The OpenClaw upstream repository changes frequently. AIWork needs a stable way
to add PKOS and Workbench integration without scattering project-specific logic
through OpenClaw core.

The operating rule is:

`Prefer a bridge plugin first, add a small generic seam second, patch core directly last.`

## Confirmed observations

### 1. OpenClaw already has a real plugin boundary

This repository is not a monolith that forces direct core edits.

Evidence:

- `extensions/` is a first-class workspace package boundary.
- `extensions/AGENTS.md` explicitly tells extension code to stay on the plugin
  side of the boundary.
- `docs/plugins/architecture.md` positions tools, hooks, HTTP routes, commands,
  providers, channels, and runtime helpers as the public extension model.
- `package.json` exports a large `plugin-sdk/*` surface intended for extension
  authors.

### 2. Git can solve text conflicts, not semantic drift

Using a fork does not make direct core edits safe by itself.

If AIWork logic is spread through frequently changing core files, upstream sync
still becomes expensive because:

- conflicts must be merged manually
- non-conflicting merges can still change runtime behavior
- regression scope becomes hard to reason about
- upgrade cadence slows down over time

### 3. The right place for AIWork-specific semantics is a bridge layer

PKOS-specific concepts such as:

- task handoff envelopes
- trace bundle intake
- review intake
- Workbench bridge paths
- PKOS root conventions

should live in a dedicated extension first.

They should not be embedded directly into OpenClaw core unless OpenClaw truly
needs a generic capability that benefits more than this one integration.

## Architectural stance

Within AIWork:

- OpenClaw: control plane
- Workbench: execution plane
- PKOS: memory and truth plane

Therefore the bridge should:

- prepare handoff artifacts
- accept trace-bundle intake
- expose review-intake placeholders
- inject role-boundary guidance

The bridge should not:

- directly redefine PKOS authority objects
- bypass review semantics
- turn OpenClaw logs into PKOS truth objects
- hardwire PKOS internals into OpenClaw core flow control

## Repository workflow

### Remotes

- `origin`: AIWork fork
- `upstream`: original OpenClaw repository

### Branch policy

- never develop directly on `main`
- do AIWork work on feature branches
- keep branch scope small and reviewable

### Sync policy

After syncing `upstream`, verify only the minimum AIWork regression chain:

- task handoff generation
- trace bundle intake
- review intake surface
- PKOS bridge status flow

Do not default to full blind retesting when only bridge seams changed.

### AI-operated Git workflow

In this repository, Git operations are expected to be performed by the coding
agent, not manually by the human operator.

Therefore future agents should follow these rules:

- treat `main` as the local clean baseline branch
- do not implement feature work directly on `main`
- create or reuse a feature branch for each scoped task
- keep `origin` as the user's fork
- keep `upstream` as the original OpenClaw repository

Current expected remote roles:

- `origin`: `git@github.com:Destibey/openclaw.git`
- `upstream`: `git@github.com:openclaw/openclaw.git`

Current branch semantics:

- local `main`: branch used to receive upstream sync
- local feature branches: branches used for AIWork customization work
- remote `origin/main`: the fork's published baseline branch
- remote feature branches: optional and only appear after an explicit push

Important clarification for future agents:

- creating a local branch with `git checkout -b <branch>` does **not** create a
  remote branch
- if the remote fork still shows only `main`, that only means the feature
  branch has not been pushed yet
- do not assume a missing remote branch means the local branch is missing

Recommended agent procedure for normal feature work:

1. inspect current branch and worktree state
2. if currently on `main`, create a feature branch before making code changes
3. implement and verify on the feature branch
4. commit on the feature branch
5. push to `origin` only when the user asks for push, PR, backup-on-remote, or
   collaborative review

Recommended agent procedure for upstream sync:

1. switch to `main`
2. `git fetch upstream`
3. merge or rebase from `upstream/main` onto local `main`
4. if the user wants the fork baseline updated too, push local `main` to
   `origin/main`
5. switch back to the active feature branch
6. merge the updated local `main` into that feature branch
7. rerun only the minimum AIWork regression chain relevant to the customized
   seam

Default branch naming rule for AI agents:

- use short feature branches with the `codex/` prefix unless the user asks for
  another naming scheme
- branch names should describe the scope, for example:
  - `codex/pkos-bridge-bootstrap`
  - `codex/pkos-bridge-contract`
  - `codex/trace-bundle-intake`

Rules for when **not** to push:

- do not push automatically just because a local commit exists
- do not publish feature branches unless the user asks
- do not force-push unless the user explicitly approves it

Rules for when a push is reasonable:

- the user explicitly asks to back up current progress to the fork
- the user asks for a GitHub-visible branch
- the user asks for a pull request workflow

Operational principle:

`AI agents should treat local branching as the default safety mechanism, and remote publishing as an explicit user decision.`

## Customization priority order

### Level 1: config

Prefer configuration when the requirement is only:

- model selection
- path wiring
- channel routing
- prompt enablement

### Level 2: bridge plugin

Prefer an extension under `extensions/` when the requirement is:

- new tools
- new hook behavior
- new HTTP routes
- new commands
- PKOS / Workbench adapter logic

### Level 3: generic seam in core

Edit core only when the bridge cannot express the requirement cleanly.

When this happens, the core change should be:

- generic
- additive
- typed
- documented
- testable

Good examples:

- a new hook
- a new runtime helper
- a new generic plugin capability

Bad examples:

- embedding PKOS path conventions directly in core
- embedding trace bundle domain logic directly in agent loop internals
- baking review-card semantics into generic OpenClaw flow control

### Level 4: direct core patch

This is the last resort. Use it only if all earlier levels fail.

## Current scaffold decision

The first AIWork landing zone in OpenClaw is:

`extensions/pkos-bridge`

The initial scaffold owns:

- tool: `pkos_bridge_status`
- tool: `pkos_bridge_prepare_task_handoff`
- tool: `pkos_bridge_submit_trace_bundle`
- gateway method: `pkosBridge.status`
- gateway method: `pkosBridge.prepareTaskHandoff`
- gateway method: `pkosBridge.submitTraceBundle`
- command: `/pkos-bridge`
- route prefix: `/plugins/pkos-bridge`
- role-boundary prompt guidance

This is intentionally a scaffold, not a finished integration.

## Suggested next implementation order

1. Freeze the task handoff object contract inside `pkos-bridge`.
2. Freeze the trace bundle intake contract inside `pkos-bridge`.
3. Add PKOS path-aware validation and serialization.
4. Add Workbench-facing adapter code.
5. Only after those are stable, decide whether OpenClaw core needs a new seam.

## Decision checklist for future edits

Before editing OpenClaw core, ask:

1. Can this live in `extensions/pkos-bridge`?
2. If not, can a generic hook or runtime seam support it?
3. If core must change, is the change additive and reusable outside AIWork?
4. Is the PKOS-specific policy still kept outside core after the seam is added?

If the answer to any of these is "no", stop and redesign before patching core.
