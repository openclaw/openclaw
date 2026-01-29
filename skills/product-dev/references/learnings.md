# Product Development Learnings

A self-improving knowledge base. Add learnings after each project or milestone.

---

## Patterns That Work

### 2026-01-28 - Clawd IDE
**Pattern:** Comprehensive PRD with ASCII mockups before any code
**Why it works:** 
- AI can reference exact specs during implementation
- No ambiguity about what "done" looks like
- Status markers make progress visible
- Easy to pick up where you left off

**How to apply:** Always create PRD-v2 style document with visual mockups for UI features before writing implementation code.

---

### 2026-01-28 - Clawd IDE
**Pattern:** Phased delivery with P0/P1/P2 priorities
**Why it works:**
- Forces MVP thinking - what's truly essential?
- Prevents scope creep - new ideas go to later phases
- Creates natural milestones for motivation
- Can ship earlier if needed

**How to apply:** Split features into 4-7 phases. Each feature gets P0/P1/P2. Complete all P0s before any P1s.

---

### 2026-01-28 - Clawd IDE
**Pattern:** Status markers updated in real-time
**Why it works:**
- PRD stays accurate as single source of truth
- Easy to see what's done vs remaining
- Git history shows progress over time
- Resume work instantly after breaks

**How to apply:** After completing any feature, immediately update its status marker. Commit PRD changes with code changes.

---

### 2026-01-28 - Clawd IDE
**Pattern:** Competitive analysis drives differentiation
**Why it works:**
- Know exactly what to copy (proven patterns)
- Know exactly what to improve (competitor weaknesses)
- Articulate your unique value proposition
- Avoid reinventing solved problems

**How to apply:** Use each major competitor for 30+ minutes. Document strengths (adopt), weaknesses (improve), gaps (differentiate).

---

### 2026-01-28 - Clawd IDE
**Pattern:** Browser-based architecture for universal access
**Why it works:**
- Works on any OS without install
- Easy to share and demo (just a URL)
- Web technologies are well-documented
- AI knows web development deeply

**How to apply:** For tools/utilities, consider browser-first architecture unless native performance is critical.

---

## Pitfalls to Avoid

### 2026-01-28 - Clawd IDE
**Pitfall:** Starting implementation before PRD is complete
**What happened:** Early versions lacked direction, had to rewrite
**Mitigation:** PRD must have all Phase 1 features fully specified with mockups before any code

---

### 2026-01-28 - Clawd IDE  
**Pitfall:** Not tracking what's actually implemented
**What happened:** PRD said "Planned" for features that were 75% done
**Mitigation:** Update status markers immediately after completing work. Use partial markers (🔄 with sub-status).

---

### 2026-01-28 - Clawd IDE
**Pitfall:** Monolithic files that are hard to navigate
**What happened:** app.js grew to 170KB, hard to find functions
**Mitigation:** Plan file structure in PRD technical architecture. Split early, not after it's painful.

---

## Technical Insights

### 2026-01-28 - Clawd IDE
**Insight:** Monaco Editor is production-ready out of the box
**Details:** Microsoft's VS Code editor component. Syntax highlighting, autocomplete, multi-cursor, find/replace all built-in.
**When to use:** Any web-based code editor project.

---

### 2026-01-28 - Clawd IDE
**Insight:** iframe-based browser embedding works but has limitations
**Details:** Can embed pages, intercept console/network, but no true DevTools. Sandbox restrictions apply.
**When to use:** Live preview features. Not for full browser automation.

---

### 2026-01-28 - Clawd IDE
**Insight:** WebSocket for real-time AI communication
**Details:** Streaming responses feel more responsive than waiting for full response.
**When to use:** Any AI-integrated application.

---

## Process Improvements

### 2026-01-28 - Clawd IDE
**Improvement:** Create GitHub repo early
**Why:** Version control from day 1. Easy to share. Backup.
**Process change:** Run `gh repo create` right after PRD is approved, before implementation.

---

### 2026-01-28 - Clawd IDE
**Improvement:** Save PRD as reusable template
**Why:** The format works. Don't recreate it each time.
**Process change:** After successful project, copy PRD to templates/ with project-specific content replaced with placeholders.

---

## Questions for Future Projects

- How to handle projects with multiple collaborators? (PRD ownership, merge conflicts)
- How to integrate user feedback loops into the workflow?
- Should there be a "tech spec" separate from PRD for complex architectures?
- How to estimate effort more accurately?

---

## Template Updates Log

| Date | Change | Reason |
|------|--------|--------|
| 2026-01-28 | Initial template from Clawd IDE PRD-v2 | Proven effective in practice |

---

*Add new learnings above. Format: Date - Project, then Pattern/Pitfall/Insight with context.*
