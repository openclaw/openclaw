# Lessons Learned - The Builders v2

Post-mortem from the OpenAI episode generation session (Jan 6, 2026).

## Issues & Fixes

### 1. Wrong Model Used
**Issue:** Used GPT-4o instead of GPT-5.2 as requested  
**Result:** 47 turns instead of 120+  
**Fix:** Always confirm model before running. Add `-m` flag to CLI.

### 2. Script Too Short in Single Pass
**Issue:** Even GPT-5.2 only generated 90 turns when asked for 120+  
**Result:** Episode too shallow (7 min instead of 25 min)  
**Fix:** **Section-by-section generation**. LLMs follow length instructions better on smaller chunks with explicit turn targets.

### 3. TTS Chunked by Size, Not by Speaker
**Issue:** Audio chunks alternated voices randomly instead of per speaker  
**Result:** Sounded like a confused monologue  
**Fix:** Parse script by `<Person1>`/`<Person2>` tags, assign consistent voice per speaker.

### 4. v3 Style Guide Not Integrated
**Issue:** The Acquired Bible existed but wasn't in the prompts  
**Result:** Generic dialogue, not Acquired-style discovery  
**Fix:** Include the Bible in EVERY section prompt. The patterns matter:
- Interruptions ("Wait—", "Hold on—")
- Discovery moments ("That's insane", "Wait, really?")
- Distinct perspectives (Maya=technical, James=strategy)

### 5. No Intro/Greeting
**Issue:** Jumped straight into hook with no "Welcome to..."  
**Result:** Felt robotic, not like real hosts  
**Fix:** Add INTRO section (8 turns) with:
- Welcome
- Casual banter
- "Today we're covering X"
- Tease the story

### 6. Voices Too Similar
**Issue:** Used nova/onyx which sound somewhat similar  
**Result:** Hard to distinguish hosts  
**Fix:** Use more distinct voices: **alloy** (female) + **echo** (male)

## What Works

### Section-by-Section
Each section has explicit turn targets:
```
INTRO:        8 turns
HOOK:        12 turns
ORIGIN:      20 turns
INFLECTION1: 18 turns
INFLECTION2: 18 turns
MESSY_MIDDLE: 14 turns
NOW:         12 turns
TAKEAWAYS:   10 turns
─────────────────────
Total:      112 turns
```

### Speaker-Aware TTS
```javascript
// WRONG - chunks by size
for (chunk of script.split(3500)) {
  voice = i % 2 === 0 ? 'nova' : 'onyx';
}

// RIGHT - parses by speaker
for (turn of script.matchAll(/<(Person[12])>(.+?)<\/Person[12]>/)) {
  voice = turn[1] === 'Person1' ? 'alloy' : 'echo';
}
```

### Bible in Every Prompt
The `acquired-bible.md` template contains:
- Host personalities
- Conversation patterns
- Language to use
- What NOT to do

Including it in every section prompt ensures consistency.

## Pipeline Summary

```
1. Gemini Deep Research (~5 min)
2. Hook Generation (~15s)
3. Section Generation (7 sections × ~20s = ~2.5 min)
4. Speaker-Aware TTS (~45s for 112 turns)
5. FFmpeg Merge (~2s)
────────────────────────────────────
Total: ~8-10 min for 20-25 min episode
```

### 7. Facts Repeated Across Sections
**Issue:** Same facts (hot dog $1.50, renewal rate 93.3%, etc.) repeated 10-20 times  
**Costco example:** Hot dog mentioned 19×, renewal rate 20×, chicken 15×  
**Root cause:** Each section generated independently with same research context  
**Fix:** **Deduplication system**
- Extract key facts after each section
- Pass "DO NOT REPEAT" list to subsequent sections
- Track up to 100 facts across sections

### 8. Process Dies Mid-Generation
**Issue:** Long-running generation killed by OOM or gateway timeout  
**Result:** Lost 30+ minutes of work, had to restart  
**Fix:** **Checkpoint system**
- Save each section immediately after generation
- Save state (usedFacts, prevContext) to JSON
- On restart, detect checkpoint and resume from last section
- Location: `<output>/checkpoints/`

## What Works

### Checkpoint System
```
<output>/checkpoints/
├── section-0.txt   # INTRO
├── section-1.txt   # HOOK
├── ...
└── state.json      # { completedSections: 5, usedFacts: [...] }
```

If process dies at section 7, re-run same command → resumes from section 7.

### Deduplication
```
Section 0: Extract 17 facts → pass to Section 1 as "DO NOT USE"
Section 1: Extract 16 facts → 33 total blocked
Section 2: Extract 14 facts → 47 total blocked
...
```

Result: 100 unique facts tracked, no repetition.

### Section-by-Section
Each section has explicit turn targets:
```
INTRO:        8 turns
HOOK:        12 turns
ORIGIN:      20 turns
INFLECTION1: 18 turns
INFLECTION2: 18 turns
MESSY_MIDDLE: 14 turns
NOW:         12 turns
TAKEAWAYS:   10 turns
─────────────────────
Total:      112 turns
```

### Speaker-Aware TTS
```javascript
// WRONG - chunks by size
for (chunk of script.split(3500)) {
  voice = i % 2 === 0 ? 'nova' : 'onyx';
}

// RIGHT - parses by speaker
for (turn of script.matchAll(/<(Person[12])>(.+?)<\/Person[12]>/)) {
  voice = turn[1] === 'Person1' ? 'alloy' : 'echo';
}
```

### Bible in Every Prompt
The `acquired-bible.md` template contains:
- Host personalities
- Conversation patterns
- Language to use
- What NOT to do

Including it in every section prompt ensures consistency.

## Pipeline Summary

```
1. Gemini Deep Research (~5 min)
2. Hook Generation (~15s)
3. Section Generation (11 sections × ~25s = ~4.5 min) [with checkpoints]
4. Speaker-Aware TTS (~2 min for 250+ turns)
5. FFmpeg Merge (~2s)
────────────────────────────────────
Total: ~12-15 min for 45-60 min deep dive
       ~8-10 min for 20 min quick dive
```

## Checklist for Future Episodes

- [ ] Confirm model (gpt-5.2 or better)
- [ ] Run deep research first
- [ ] Generate section-by-section
- [ ] Include Bible in all prompts
- [ ] Parse by speaker tags for TTS
- [ ] Use alloy + echo voices
- [ ] Verify intro section exists
- [ ] Listen to first 30s to check voice distinction
- [ ] Verify no repeated facts (deduplication working)
- [ ] If process dies, just re-run same command (checkpoint resume)
