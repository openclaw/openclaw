---
summary: "Implementation plan for the custodian onboarding redesign (living document)"
read_when:
  - You are implementing or reviewing a phase of the onboarding redesign
title: "Onboarding redesign"
---

# Onboarding redesign — implementation plan

> **Living document.** This page tracks the custodian onboarding redesign at
> implementation level and is updated as each phase lands. When the last phase
> merges, this page is rewritten as the user-facing onboarding guide and joins
> the docs navigation. It is intentionally not in `docs.json` until then.

## North star

A non-technical user types `openclaw onboard` (or opens the app) and is greeted
by one conversational presence — OpenClaw, the system custodian ("custodian" is
the internal name only; the user always sees "OpenClaw") — that finds their AI,
sets everything up with announced defaults instead of questions, hatches their
agent as a visible identity moment, and stays reachable forever after as the
system's caretaker. Magic by default, one consent boundary, no dead ends.

Design principles (decided, do not relitigate casually):

- **Announced defaults with easy undo** replace blocking questions. The only
  hard requirement is working inference; everything else is an offer.
- **Question zero is the consent boundary**: "Full access" (recommended) means
  discovery is silent and automatic; "Ask first" gates every discovery — AI
  scanning and memory-source scanning alike — behind one explicit yes, with a
  fully manual path that never scans.
- **Conversation as UI with progressive intelligence**: the custodian surface
  exists before any AI works (scripted dialogue), becomes model-backed the
  moment a route verifies, and visibly says so.
- **The hatch is a ceremony**: same thread, avatar swap, the agent names itself
  and picks its own face. The custodian teaches the hierarchy once: "ask me
  about the system, or just ask your agent — it relays."
- **Configured installs are sacred**: re-running onboarding is a verification
  pass. It never re-applies setup and never restarts the Gateway service.
- **Weak models get a trimmed surface** (auto `localModelLean`), explained in
  plain words — never in terms of tools, code mode, or context windows.

## Phases

| #   | Phase                                                                                                                                                                     | Surface                  | Status                                                                     |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | -------------------------------------------------------------------------- |
| 1   | Installed-app plugin recommendations (scan, candidates, AI matcher, wizard step, `device.apps` node command)                                                              | service + classic wizard | PR [#109668](https://github.com/openclaw/openclaw/pull/109668) — in review |
| 2   | CLI custodian spine (question zero, discovery theater, auto-apply + hatch)                                                                                                | guided CLI               | PR [#109841](https://github.com/openclaw/openclaw/pull/109841) — in review |
| 3   | Browser-first handoff (GUI-session detection, wait-for-dashboard-connect, TUI as fallback)                                                                                | CLI → web                | planned                                                                    |
| 4   | Web custodian surface (option-card renderer shared with the question tool, scripted pre-AI states over `openclaw.chat`, post-wizard chat handoff)                         | Control UI               | planned                                                                    |
| 5   | Hatch and bootstrap (blank-agent creation, self-naming, self-drawn avatar via image-gen when available, recommendations as the last bootstrap step, self-learning opt-in) | agent bootstrap          | planned                                                                    |
| 6   | Custodian presence (pinned sidebar entry, Settings dock with event-reactive commentary, channel summon and agent-down recovery, weak-model script)                        | web + channels           | planned                                                                    |
| 7   | Resilience (custodian reachable on broken config, partial-surface salvage, auto-doctor)                                                                                   | gateway                  | follow-up                                                                  |

## Implementation notes per phase

### Phase 1 — app recommendations (PR #109668)

- Scanner: `src/infra/installed-apps.ts` (TCC-free macOS enumeration).
- Candidates: official catalogs + ClawHub search, 20s budget, graceful offline.
- AI matcher: one completion on the verified route
  (`src/system-agent/setup-app-recommendations.ts`); no curated bundle-id map —
  the model rejects coincidental name overlaps.
- Node command `device.apps` (TS node-host, Android envelope parity), sharing
  off by default; gateway kill switch `wizard.appRecommendations`.
- Delivery currently lives in the classic wizard
  (`src/wizard/setup.app-recommendations.ts`); it re-targets to the bootstrap
  tail in phase 5 (the service already takes an injectable inventory source).
- Also fixed: custom `completeSetupInference` prompts no longer inherit the
  32-token verification-probe output cap.

### Phase 2 — CLI custodian spine (PR #109841)

- Flow rework in `src/commands/onboard-guided.ts`; remote-gateway onboarding
  keeps its legacy chat handoff via `handoffMode: "chat"`.
- Question zero persists `wizard.accessMode` ("full" | "guarded"); reruns
  default to the saved choice. Guarded + manual uses
  `listManualSetupInferenceOptions` (config/manifests only, no probing) and
  skips memory-source scanning.
- Discovery: quiet failure collection (single summary line; details behind
  "See other options"), coding-agent quip, announced route default.
- Fresh installs: `applySystemAgentSetup` (the deterministic conversational
  "yes"), then hatch via `launchTuiCli` seeded with the bootstrap message.
  Configured installs (pre-existing model or gateway config): verification
  only — no apply, no Gateway service restart. Apply failure falls back to the
  conversational chat.

### Phase 3 — browser-first handoff (planned)

- Detect a graphical session (macOS Aqua vs `SSH_CONNECTION`); GUI opens the
  tokened dashboard URL, headless prints it large and waits.
- The readiness signal is a Control UI client connecting to the gateway — not
  the `open` exit code. No connect within the window → the same flow renders in
  the terminal. The TUI stops being a question and becomes plan C.

### Phase 4 — web custodian surface (planned)

- One option-card component (header, question, 2–4 cards, one recommended,
  always skippable) shared by scripted onboarding and the agent question tool
  (`src/agents/harness/user-input-bridge.ts` shapes).
- Scripted pre-AI dialogue as a small state machine consumed by CLI and web;
  the web page runs over the existing `openclaw.chat` RPC in the chrome-hiding
  onboarding mode. The model-setup wizard pages remain as the "More options"
  fallback, embedded as cards.
- The scripted custodian must never fake intelligence: free-text input before
  a route verifies gets a graceful "let me get my brain working first".

### Phase 5 — hatch and bootstrap (planned)

- Custodian creates a nameless agent (tool call); the agent's bootstrap opens
  with self-naming and a self-drawn avatar (image-gen ladder: model-generated
  candidates → preset marks → keep logo). Same thread, avatar swap; the claw
  mark stays reserved for the custodian.
- Recommendations (phase 1 service, stored scan) land as the last bootstrap
  step before the bootstrap file is removed: "minimal set or maximum
  convenience?" Channel connect buttons carry per-channel setup playbooks; the
  agent collects credentials conversationally and relays config writes to the
  custodian ("asking OpenClaw…" is the canonical idiom).
- Self-learning is asked, not announced, and doubles as skill-workshop consent;
  ClawHub is described as "scanned, signed, and verified before install" —
  nothing stronger.
- Auto-hatch: after AI verifies, hatching proceeds with an announcement
  ("You can always find me in Settings… hatching now"); the button only skips
  the beat. Zero agents on first run auto-hatches; zero agents after deletion
  offers instead.

### Phase 6 — custodian presence (planned)

- Pinned sidebar entry (permanent session — it is the config audit trail) and
  Settings landing pane docked with the same session; replies deep-link into
  settings sections.
- Event-reactive commentary with anti-Clippy guardrails: consequential or
  failed changes only, at most once per settings visit unless asked.
- Channels: day-to-day invisible (the agent relays); reachable by explicit
  summon and on agent-down events in the same thread, with its own name and
  avatar where the platform allows.
- Weak model detected at setup: auto-set `localModelLean`, and the custodian
  says so in plain words with an upgrade offer.

### Phase 7 — resilience (follow-up)

- The custodian must be reachable no matter how broken the config is: salvage
  working surfaces (per the gateway's degraded-start SecretRef rules), say
  plainly what is broken, and run `openclaw doctor` automatically.

## Decision log

- Magical scan with kill switch, not consent-first (phase 1; disclosure lives
  in the scanning progress line and results note).
- Full vertical including the node `device.apps` command (phase 1).
- Two access cards, not three; consent front-loaded into the choice (phase 2).
- Auto-hatch with announcement, not a blocking button (phases 2/5).
- Custodian gets channel presence (summon + recovery), not web/CLI only
  (phase 6).
- Hatch happens in the same thread with an avatar swap; after completion the
  app transitions to the regular UI (phase 5).
- The settings surface keeps the name "Settings"; the custodian lives there
  (and in the sidebar) rather than replacing it (phase 6).
- User-facing copy never says "code mode", "tools", or "context window" when
  explaining weak-model trimming (phase 6).
