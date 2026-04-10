# Slack Channel Map

| Channel | Post | Read | Purpose |
|---|---|---|---|
| `#market-signals` | Scout | all | Intraday facts, unusual moves, earnings beats, scheduled scans |
| `#research` | Analyst | all | Source-backed fundamental theses |
| `#quant-signals` | Quant | all | Computed technical signals, backtest pointers |
| `#contrarian` | Devil's Advocate | all | Stress tests, kill conditions, risk flags |
| `#dispatch` | Orchestrator | all | One-question-per-agent task assignments |
| `#portfolio-daily` | Orchestrator | all | **Canonical daily decisions + brief (replaces `recent-decisions.md`)** |
| `#portfolio-weekly` | Orchestrator | all | Weekly synthesis |
| `#watchlist` | Orchestrator (canonical) + Scout (morning build) | all | **Canonical active coverage list (replaces `watchlist.md`)** |
| `#weekly-outlook` | Scout | all | Sunday wrap + red-folder calendar for the week ahead |
| `#themes` | any | all | Thematic ideas, long-form riffs |
| `#agents` | any | all | Team coordination, meta, ops |

## Canonical state rules

- **Watchlist lives in `#watchlist`.** There is no `watchlist.md`. Scout rebuilds each pre-market via `build_morning_watchlist`; Orchestrator publishes any mid-day changes via `update_watchlist`. Every agent reads the last ~20 messages in `#watchlist` on startup to learn current coverage.
- **Decisions live in `#portfolio-daily`.** There is no `recent-decisions.md`. Orchestrator posts each decision there as a dated, structured message via `publish_daily_brief`. Every agent reads the tail of `#portfolio-daily` on startup to learn recent decisions.

## Ownership rules

- Specialists post only to their owned channels (plus `#themes` / `#agents` for meta).
- Only the Orchestrator dispatches work (`#dispatch`) and publishes canonical watchlist + decisions.
- Devil's Advocate reads every channel and may ask follow-up questions directly in the specialist's own channel (see `follow_up_questions` skill).
- No hidden tasking, no DMs for work, no side threads.

## Slack mentions

- Orchestrator: `@Orchestrator - Portfolio Manager`
- Scout: `@Scout - Market Intelligence`
- Analyst: `@Analyst - Fundamental Research`
- Quant: `@Quant - Technical & Quantitative`
- Devil's Advocate: `@Devil's Advocate - Risk & Contrarian`

## Agent-to-agent protocol

- If you need another agent to see, acknowledge, and act on a Slack message, use that agent's exact `@...` mention in the message body.
- Do not assume another agent saw a post unless you explicitly `@` mentioned them.
- All cross-agent coordination stays visible in shared Slack channels.
- A2A (agent-to-agent direct) is enabled **only for pulling finished artifacts** from another agent's `files/` folder. Never use A2A for tasking, discussion, or coordination — those stay in Slack. See `a2a_artifact_pull` shared skill.
