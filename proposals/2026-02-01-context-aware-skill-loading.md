# OpenClaw Contribution Proposal: Context-Aware Dynamic Skill Loading

**Date:** 2026-02-01  
**Issue:** [#6691](https://github.com/openclaw/openclaw/issues/6691)  
**Status:** Draft  
**Impact:** 🔥 HIGH (Cost reduction + performance)

---

## Problem

**Users with many skills (10+) face excessive token costs (~15k input tokens per request) because ALL skill documentation loads into context for EVERY request, regardless of relevance.**

Real example from issue:
- 11 skills installed
- ~15k input tokens per request
- Most skills irrelevant to the current task
- Token costs scale linearly with skill count
- Users forced to choose between skill variety and cost

Current workaround: `--disable-model-invocation` flag, but this **loses context-awareness entirely**.

---

## Why It Occurs

**Root cause:** OpenClaw's current architecture loads the entire skill library into context at session start:

```typescript
// Current behavior (simplified)
const skills = loadAllSkills(workspace);
const context = buildPrompt({
  systemMessage,
  workspaceFiles,
  skills: skills.map(s => s.SKILL_MD), // ALL skills loaded
  conversationHistory
});
```

**Why this was designed this way:**
1. Simplicity - agent always knows what tools exist
2. No lookup overhead during conversation
3. Skills are lightweight in early versions (2-5 skills typical)

**But it doesn't scale:**
- Skill ecosystem grew (50+ skills available)
- Power users install 10-20 skills
- Each SKILL.md averages 500-1500 tokens
- 15 skills = ~12k tokens baseline before ANY conversation

---

## Technical Solution

### Proposed Approach: Intent-Based Skill Loading (Hybrid RAG)

**Phase 1: Semantic Skill Index (Low-hanging fruit)**

1. **Pre-index all skills** with embeddings:
   ```typescript
   interface SkillIndex {
     name: string;
     description: string; // from SKILL.md metadata
     triggers: string[];   // "trigger phrases" section
     embedding: number[];  // from description + triggers
   }
   ```

2. **Two-pass system:**
   - **Pass 1 (lightweight):** Load only skill names + 1-line descriptions
   - **Agent sees:** "Available: apple-notes (manage notes), github (PR/issues), weather (forecasts)..."
   - **If agent calls a skill:** Load full SKILL.md dynamically

3. **Smart pre-loading:**
   - Embed user message
   - Semantic search against skill index
   - Load top 3-5 relevant skills into context
   - Rest stay dormant until explicitly invoked

**Implementation sketch:**
```typescript
// Startup: build skill index
const skillIndex = await buildSkillIndex(skills);

// Per-message:
async function buildContext(message, conversationHistory) {
  const relevantSkills = await semanticSearch(
    skillIndex, 
    message, 
    topK: 5
  );
  
  return {
    system: baseSystemPrompt,
    skills: relevantSkills.map(s => loadSkillDoc(s)), // Only 5!
    skillDirectory: skillIndex.map(s => s.summary),   // Lightweight
    history: conversationHistory
  };
}
```

**Phase 2: Learning Layer (Future)**
- Track which skills actually get used together
- Build co-occurrence graph
- If user invokes `github`, pre-load `git` skill too
- Personalized skill loading per user patterns

---

## How It Solves the Problem

### Immediate Impact

**Before:**
- 15 skills = ~12k tokens baseline
- Cost: ~$0.015 per request (Claude Opus)
- 100 requests/day = $1.50/day = $45/month

**After (Phase 1):**
- 15 skills indexed, 5 loaded per request = ~4k tokens baseline
- Cost: ~$0.005 per request
- 100 requests/day = $0.50/day = $15/month
- **$30/month savings** (67% reduction)

### Performance Gains
- Faster prompt assembly (less text to process)
- Lower latency (fewer tokens to send)
- Better model focus (only relevant context)

### User Experience
- No manual skill management needed
- No loss of functionality
- Transparent to end users
- Power users can install unlimited skills guilt-free

---

## Impact Assessment

### Who Benefits
1. **Power users** with 10+ skills (immediate 60-70% token reduction)
2. **EC2/cloud deployments** (reduces AWS egress costs)
3. **Skill developers** (more skills = more usage, no cost penalty)
4. **OpenClaw adoption** (removes barrier to skill exploration)

### Risk Assessment
**Low risk:**
- Backward compatible (falls back to full loading if semantic search fails)
- Incremental rollout (flag-gated: `skills.dynamicLoading: true`)
- No API changes required

**Complexity:**
- Medium (requires embedding service + semantic search)
- Can use existing OpenAI/Anthropic embeddings
- ~500 lines of new code estimated

### Adoption Path
1. **Week 1:** Implement skill index + semantic search
2. **Week 2:** Add two-pass loading system
3. **Week 3:** Beta flag + testing with 5-10 power users
4. **Week 4:** Graduate to default behavior
5. **Future:** Add learning layer

---

## Next Steps

If approved:
1. Create feature branch: `feat/context-aware-skill-loading`
2. Implement skill indexing system
3. Add `skills.dynamicLoading` config option
4. Write tests for edge cases (no skills match, all skills match)
5. Documentation update (explain how semantic loading works)
6. Submit PR with benchmarks

**Estimated effort:** 2-3 days for Phase 1 MVP

---

**Author:** Cheenu (cheenu1092@gmail.com)  
**Collaborators:** Open to feedback from @steipete and community
