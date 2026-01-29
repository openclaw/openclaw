# PRD Reconciliation Skill

**MANDATORY SKILL** — This skill MUST be loaded and followed for ANY PRD status query. Never answer PRD status questions directly from documentation.

> ⚠️ **HARD RULE:** Do not state PRD feature status as fact unless you have run this reconciliation protocol in this session. If asked for status without running verification, respond: "I need to run PRD reconciliation first."

## Trigger Phrases (Auto-Load This Skill)

Any of these phrases MUST trigger loading this skill:
- "PRD status" / "status of PRD"
- "what's done" / "what's implemented"
- "progress report" / "current state"
- "check status" / "verify status"
- "is X implemented" / "is X done"
- "how far along" / "completion status"
- "reconcile PRD" / "verify PRD"

## Core Principle

> **Documentation describes intent; code describes reality. When they disagree, CODE WINS.**

PRDs drift from implementation during active development. This skill ensures you **never trust documentation without verification**.

---

## Protocol (MUST FOLLOW IN ORDER)

### Step 1: Locate PRD and Source Files

```bash
# Find PRD
find /path/to/project -name "PRD*.md" -o -name "prd*.md" | head -5

# Identify source directories
ls -la /path/to/project/src/ /path/to/project/public/ /path/to/project/server/ 2>/dev/null
```

### Step 2: Get Code Metrics FIRST (Before Reading PRD)

```bash
# Overall implementation size
wc -l project/**/*.js 2>/dev/null | tail -5

# Function count (rough complexity)
grep -c "function\|const.*=>\|async " project/**/*.js 2>/dev/null | sort -t: -k2 -nr | head -10

# List all source files
find project -name "*.js" ! -path "*/node_modules/*" | head -20
```

### Step 3: Feature-by-Feature Verification

For EACH feature/phase in the PRD:

```bash
# Check if feature exists in code
grep -rn "featureKeyword\|FeatureKeyword" project/src/ project/public/ | head -10

# Check for API endpoints
grep -n "app\.\(get\|post\|put\|delete\).*'feature'" project/server/*.js

# Check for UI components
grep -n "function.*Feature\|Feature.*=" project/public/*.js
```

**Completion estimation:**
| Indicator | Status |
|-----------|--------|
| 0 matches | 📋 Planned (0%) |
| Basic structure only | 🔄 Started (~20%) |
| Core logic present | 🔄 In Progress (~50%) |
| Full implementation | 🔄 Nearly Done (~80%) |
| Tests + edge cases + polish | ✅ Complete (~95%+) |

### Step 4: NOW Read PRD Status Markers

Only after code inspection, read the PRD to see what it claims:

```bash
grep -n "Status.*Complete\|Status.*Planned\|Status.*Progress\|✅\|🔄\|📋" PRD.md
```

### Step 5: Generate MANDATORY Status Report

**You MUST output this exact format. No exceptions.**

```markdown
## [Project] PRD Reconciliation Report
**Date:** YYYY-MM-DD HH:MM
**Method:** Code verification first, then PRD comparison
**Skill:** prd-reconciliation v1.1

### Verification Commands Run
- `wc -l ...` — [X total lines]
- `grep -c "function" ...` — [Y functions]
- [List all grep commands used for each feature]

### Status Comparison

| Phase/Feature | PRD Claims | Code Shows | Δ | Confidence | Evidence |
|---------------|------------|------------|---|------------|----------|
| Phase 1 | 90% | 95% | +5% | High | 33 function matches |
| Phase 2 | 60% | 85% | +25% | High | Full API endpoints |

### Discrepancies Found
- [List every case where PRD ≠ Code]

### PRD Updates Needed
- [ ] Update Phase X from Y% to Z%
- [ ] Add implementation notes for feature A
- [ ] Update "Last Updated" date

### Recommendations
- [Next steps]
```

**FAIL CONDITIONS:** If your report doesn't include:
- [ ] Verification commands with output
- [ ] Doc Says / Code Shows table
- [ ] Confidence levels
- [ ] Evidence for each claim

Then you have NOT completed reconciliation. Start over.

---

## Quick Reconciliation Script

```bash
./skills/prd-reconciliation/reconcile.sh /path/to/project
```

---

## Post-Reconciliation

After completing features during development:
1. **Immediately update PRD status marker** — 📋 → 🔄 → ✅
2. **Update feature checklist** — `[ ]` → `[x]`
3. **Bump "Last Updated" date**
4. **Note in daily memory** — `memory/YYYY-MM-DD.md`

---

## Integration

### With BugDNA
If reconciliation reveals >20% drift:
- Record as process bug (documentation-drift pattern)
- Link to `knowledge/patterns/documentation-accuracy.md`

### With Heartbeat
Add to `HEARTBEAT.md` weekly check:
```
- [ ] **PRD Reconciliation:** If active project has PRD and >7 days since last reconciliation, run this skill
```

---

## Why This Matters

This skill exists because I (Clawd) have repeatedly made the mistake of trusting PRD documentation over code reality. Bug records:
- `knowledge/bugs/2026-01-28-003-prd-status-drift.md`
- `knowledge/bugs/2026-01-28-004-compaction-silent-truncation.md` (related)

**Never again.** Code wins. Always verify.
