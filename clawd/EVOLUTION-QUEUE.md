# Evolution Queue

> System improvements — how Liam works, multi-agent coordination, tools, infra.
> For Liam's projects and ventures, see `PROJECTS.md`.

---

## How to Submit

**REQUIRED: Verify before submitting.** Run verification command, paste output as evidence.

```
### [YYYY-MM-DD-NNN] Short title
- **Proposed by:** Liam
- **Date:** YYYY-MM-DD
- **Category:** behavior | identity | rules | tools | memory | showcase-idea
- **Target file:** (which file would change, or "new skill")
- **Verified:** [YES - ran grep/command] or [N/A - new feature]
- **Evidence:** `[paste command output showing issue exists]`
- **Description:** What to change and why
- **Status:** pending
```

**Verification commands:**
- "Missing from file X": `grep -n "[feature]" ~/clawd/[file].md`
- "Tool broken": `which [tool] && [tool] --help`
- "Cron failing": `clawdbot cron list | grep [job]`

**RULE:** If grep FINDS the feature, DO NOT create the entry (it's a ghost bug).

---

## Queue Hygiene Rules

**RULE: Resolved items must be archived immediately.**

The Evolution Queue should ONLY contain:
- **NEW** - Not yet started
- **IN PROGRESS** - Currently being worked on
- **PENDING** - Waiting on external input (Simon, etc.)
- **SCHEDULED** - Future dated items
- **PAUSED** - Deliberately paused, will resume later

Items with these statuses must be moved to `EVOLUTION-QUEUE-ARCHIVE.md`:
- **RESOLVED** - Successfully completed
- **CANNOT REPRODUCE** - Unable to verify issue
- **REJECTED** - Will not implement
- **DUPLICATE** - Already covered by another item
- **GHOST BUG** - Feature already exists

---

## Pending (System)

### [2026-01-28-049] Telegram Liam Identity/Tool Access Failure
- **Proposed by:** Liam (Discord)
- **Date:** 2026-01-28
- **Category:** behavior
- **Target file:** ~/.clawdbot/moltbot.json (agent configuration)
- **Verified:** [YES - session log analysis]
- **Evidence:** Session `3aef7051` shows Telegram Liam has no tool access and no identity; full diagnostic at `~/clawd/diagnostics/telegram-identity-failure-2026-01-28.md`
- **Description:** Telegram Liam operates as generic AI with no file access, no tools, and no knowledge of identity. Does not read SOUL.md/IDENTITY.md/MEMORY.md. When asked to read a file, responds "I don't have access to read files from your local system." Discord Liam works correctly. Likely missing tool permissions or session initialization for Telegram channel.
- **Impact:** CRITICAL - Telegram users get generic AI instead of Liam
- **Status:** NEW

### [2026-02-10-042] Debug Mode Frequency Reversion (SCHEDULED)
- **Proposed by:** Cursor
- **Date:** 2026-01-28
- **Scheduled for:** 2026-02-10
- **Description:** Revert debug mode frequencies to normal after 2-week dev period. Actions: disable Evening-Self-Audit + Model-Health-Check cron jobs, revert self-evaluation/Queue-Cleanup to Sunday only.
- **Status:** SCHEDULED

### [2026-01-27-046] Dashboard Chat Window
- **Proposed by:** Simon (via Telegram)
- **Date:** 2026-01-27
- **Category:** tools
- **Target file:** ~/clawd/dashboard/
- **Description:** Add a chat window to the dashboard that allows chatting with Liam directly from the web interface.
- **Impact:** High - Direct interaction without switching to Telegram/Discord
- **Status:** PENDING

### [2026-01-27-047] Dashboard Session Visibility
- **Proposed by:** Simon (via Telegram)
- **Date:** 2026-01-27
- **Category:** tools
- **Target file:** ~/clawd/dashboard/
- **Description:** Show what all Liam sessions are doing in the dashboard. Display active sessions across all agents (Telegram, Discord, etc.) with their current state.
- **Impact:** Medium - Visibility into agent activity
- **Status:** PENDING

### [2026-01-27-048] Dashboard Subagent Visibility
- **Proposed by:** Simon (via Telegram)
- **Date:** 2026-01-27
- **Category:** tools
- **Target file:** ~/clawd/dashboard/
- **Description:** Show subagent activity in the dashboard. Display spawned subagents, their tasks, and status.
- **Impact:** Medium - Visibility into subagent orchestration
- **Status:** PENDING

---

## In Progress

### [2026-01-25-007] Low-Friction Capture Methods
- **Proposed by:** Liam
- **Date:** 2026-01-25
- **Category:** tools
- **Description:** NeuroSecond <2 second capture via natural language (Telegram) and email (clawdbot@puenteworks.com).
- **Impact:** High - Critical for NeuroSecond methodology
- **Status:** IN PROGRESS (natural-capture skill)

---

## Paused

### [2026-01-28-043] GLM-4.7-Flash vs Kimi K2.5 Model Comparison [TESTED]
- **Date:** 2026-01-28
- **Description:** Compare models for Discord Liam.
- **Testing Results (2026-01-28):**
  - Kimi K2.5 Cloud successfully integrated and tested on Discord
  - **Pros:** Advanced reasoning with visible "thinking", 256K context, multimodal (vision)
  - **Cons:** Has baked-in "Your name is Kimi" identity that conflicts with SOUL.md
  - Model correctly applies file precedence (SOUL.md > system prompt) but wastes tokens resolving conflict
  - Free Ollama Cloud tier has undocumented rate limits
- **Current config:** Discord uses `ollama/kimi-k2.5:cloud` with GLM fallbacks
- **Recommendation:** Monitor for rate limit issues; consider switching to local GLM-4.7-Flash if identity conflict is problematic
- **Status:** TESTED - monitoring

---

## Approved

*(No approved items pending implementation)*

---

*For Liam's projects and ventures, see PROJECTS.md*
