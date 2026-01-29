# PRD: Self-Learning & User Knowledge System
## Clawd IDE — Making AI Memory Visible

**Version:** 1.1  
**Date:** 2026-01-29  
**Author:** Clawd 🐾  
**Status:** Approved — Ready for Implementation

---

## Table of Contents
1. [Executive Summary](#1-executive-summary)
2. [Problem Statement](#2-problem-statement)
3. [Goals & Success Metrics](#3-goals--success-metrics)
4. [System Architecture](#4-system-architecture)
5. [Memory Types & Categories](#5-memory-types--categories)
6. [Recording Mechanisms](#6-recording-mechanisms)
7. [Agent Responsibilities](#7-agent-responsibilities)
8. [Triggers & Timing](#8-triggers--timing)
9. [Data Storage Architecture](#9-data-storage-architecture)
10. [Confidence & Verification](#10-confidence--verification)
11. [Privacy & Security](#11-privacy--security)
12. [User Interface](#12-user-interface)
13. [Implementation Plan](#13-implementation-plan)
14. [Technical Specifications](#14-technical-specifications)
15. [Open Questions](#15-open-questions)

---

## 1. Executive Summary

### Vision
Transform Clawd from a stateless assistant into a **continuously learning companion** that builds a rich, persistent understanding of the user across all interactions — visible, verifiable, and user-controlled.

### Key Innovation
Unlike existing AI memory systems (Mem0, ChatGPT Memory) which operate invisibly, we make learning **transparent and interactive**:
- Users SEE what Clawd learns in real-time
- Users can CORRECT, CONFIRM, or DELETE any knowledge
- Learning is GAMIFIED to encourage engagement
- Knowledge builds across ALL channels (IDE, WhatsApp, Discord)

### Core Principle
> "Memory without visibility is surveillance. Memory with visibility is partnership."

---

## 2. Problem Statement

### Current State
1. **DNA has memory files** (`MEMORY.md`, `memory/*.md`) but they're:
   - Manually maintained by the agent
   - Not systematically structured
   - Not visible to users in real-time
   - Not leveraged for learning patterns

2. **Users don't know** what Clawd remembers or learns
3. **Patterns are lost** — Same corrections given repeatedly
4. **No feedback loop** — User can't validate AI's understanding

### Research Insights (Mem0, AWS AgentCore, 2025-2026)

**From Mem0 Research:**
- 26% accuracy improvement with structured memory
- 91% lower latency than full-context approaches
- 90% token savings with selective retrieval
- Graph-based memory captures relational structures

**Key Architectural Patterns:**
1. **Extraction Phase** — Process message pairs to identify salient memories
2. **Update Phase** — Evaluate new vs existing, apply CRUD operations
3. **Graph Relationships** — `entity → relationship → entity` (e.g., "Ivan → owns → Gusar Distribution")
4. **Dual Context** — Summary + recent messages for extraction
5. **Incremental Processing** — Works on message pairs, not batches

---

## 3. Goals & Success Metrics

### Primary Goals
| Goal | Metric | Target |
|------|--------|--------|
| Visible Learning | Users check Brain Panel weekly | 70%+ |
| Accuracy | User confirmations vs corrections | 85%+ accuracy |
| Engagement | Average streak length | 14+ days |
| Utility | "Clawd anticipated my need" moments | 3+/week |
| Trust | Users comfortable with stored data | 90%+ |

### Secondary Goals
- Reduce repeated corrections by 80%
- Build comprehensive user profile in 30 days
- Cross-channel knowledge sharing (IDE ↔ WhatsApp)
- Enable proactive suggestions based on learned patterns

---

## 4. System Architecture

### High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         USER INTERACTIONS                        │
│    ┌─────────┐    ┌─────────┐    ┌─────────┐    ┌─────────┐    │
│    │   IDE   │    │WhatsApp │    │ Discord │    │ Telegram│    │
│    └────┬────┘    └────┬────┘    └────┬────┘    └────┬────┘    │
│         │              │              │              │          │
│         └──────────────┴──────────────┴──────────────┘          │
│                              │                                   │
│                              ▼                                   │
│    ┌─────────────────────────────────────────────────────────┐  │
│    │              DNA GATEWAY (Main Agent)               │  │
│    │                                                          │  │
│    │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │  │
│    │  │   Message    │  │   Memory     │  │   Response   │  │  │
│    │  │   Handler    │→ │   Extractor  │→ │   Generator  │  │  │
│    │  └──────────────┘  └──────┬───────┘  └──────────────┘  │  │
│    │                           │                              │  │
│    └───────────────────────────┼──────────────────────────────┘  │
│                                │                                  │
│                                ▼                                  │
│    ┌─────────────────────────────────────────────────────────┐  │
│    │                 MEMORY SUBSYSTEM                         │  │
│    │                                                          │  │
│    │  ┌────────────┐  ┌────────────┐  ┌────────────┐        │  │
│    │  │  Extract   │  │  Evaluate  │  │   Store    │        │  │
│    │  │  (LLM)     │→ │  (LLM)     │→ │  (Graph)   │        │  │
│    │  └────────────┘  └────────────┘  └────────────┘        │  │
│    │         │                              │                 │  │
│    │         │        ┌────────────┐        │                 │  │
│    │         └───────→│ Consolidate│←───────┘                 │  │
│    │                  │ (Subagent) │                          │  │
│    │                  └─────┬──────┘                          │  │
│    │                        │                                 │  │
│    └────────────────────────┼─────────────────────────────────┘  │
│                             │                                     │
│                             ▼                                     │
│    ┌─────────────────────────────────────────────────────────┐  │
│    │                    STORAGE LAYER                         │  │
│    │                                                          │  │
│    │   ┌──────────────┐    ┌──────────────┐                 │  │
│    │   │ localStorage │    │  memory/*.md │                  │  │
│    │   │  (Fast/IDE)  │←──→│ (Persistent) │                  │  │
│    │   └──────────────┘    └──────────────┘                  │  │
│    │                                                          │  │
│    │   ┌──────────────────────────────────────────┐          │  │
│    │   │         knowledge/user-graph.json        │          │  │
│    │   │   (Structured Graph: Entities + Relations)│          │  │
│    │   └──────────────────────────────────────────┘          │  │
│    │                                                          │  │
│    └─────────────────────────────────────────────────────────┘  │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
```

### Component Responsibilities

| Component | Role | Model |
|-----------|------|-------|
| **Main Agent** | Conversation, complex reasoning | Opus |
| **Memory Extractor** | Extract salient facts from messages | Main Agent (inline) |
| **Memory Evaluator** | Compare new vs existing, decide CRUD | Main Agent (inline) |
| **Consolidator** | Batch analysis, pattern detection | Subagent (Kimi/GPT-5) |
| **Graph Manager** | Store/retrieve structured knowledge | Code (no LLM) |
| **UI Renderer** | Display in Brain Panel | JavaScript |

---

## 5. Memory Types & Categories

### 5.1 Memory Taxonomy

```
MEMORY
├── FACTUAL (Explicit — user stated)
│   ├── Identity
│   │   ├── name, dob, location, timezone
│   │   ├── contact info (email, phone)
│   │   └── accounts & credentials
│   ├── Family
│   │   ├── spouse, children, parents
│   │   └── relationships & dynamics
│   ├── Business
│   │   ├── companies owned/employed
│   │   ├── partners, employees
│   │   ├── financial metrics
│   │   └── active projects
│   └── Goals
│       ├── short-term (this week)
│       ├── medium-term (this quarter)
│       └── long-term (this year+)
│
├── BEHAVIORAL (Inferred — observed patterns)
│   ├── Decision Patterns
│   │   ├── risk tolerance
│   │   ├── research depth
│   │   ├── speed vs thoroughness
│   │   └── delegation comfort
│   ├── Work Patterns
│   │   ├── active hours
│   │   ├── focus session length
│   │   ├── context switching
│   │   └── tool preferences
│   └── Communication Style
│       ├── tone preference
│       ├── detail level
│       ├── format preference
│       └── response timing expectations
│
├── CODING (Technical preferences)
│   ├── Style
│   │   ├── naming conventions
│   │   ├── formatting (semicolons, quotes)
│   │   ├── async patterns
│   │   └── import style
│   ├── Architecture
│   │   ├── framework preferences
│   │   ├── file organization
│   │   └── testing approach
│   └── Patterns
│       ├── error handling style
│       ├── logging preferences
│       └── documentation level
│
├── TEMPORAL (Time-sensitive)
│   ├── Current Focus
│   │   └── What user is working on NOW
│   ├── Recent Decisions
│   │   └── Last 7 days of choices made
│   └── Upcoming Events
│       └── Deadlines, meetings, milestones
│
└── RELATIONAL (Graph edges)
    ├── owns (Ivan → Gusar Distribution)
    ├── works_with (Ivan → Mikhail)
    ├── married_to (Ivan → Alexandra)
    ├── prefers (Ivan → camelCase)
    └── decided (Ivan → "phased approach" @ 2026-01-28)
```

### 5.2 Confidence Levels

| Level | Confidence | Source | Icon | Example |
|-------|------------|--------|------|---------|
| **Confirmed** | 95-100% | User explicitly stated | 🟢 | "My wife is Alexandra" |
| **Validated** | 80-95% | User confirmed inference | 🔵 | Confirmed "you prefer tables" |
| **Inferred** | 50-80% | Observed pattern (N>3) | 🟡 | Noticed 5x preference for async/await |
| **Tentative** | 20-50% | Limited observations (N≤3) | 🟠 | Seen 2x, might be coincidence |
| **Guessed** | <20% | Single observation | 🔴 | One-time behavior |

### 5.3 Memory Lifecycle

```
┌──────────┐     ┌──────────┐     ┌──────────┐     ┌──────────┐
│ Observed │ ──→ │ Tentative│ ──→ │ Inferred │ ──→ │ Confirmed│
│   🔴     │     │    🟠    │     │    🟡    │     │    🟢    │
└──────────┘     └──────────┘     └──────────┘     └──────────┘
     ↑                                                   │
     │                                                   │
     └───────────────── (contradicted) ←─────────────────┘
                              │
                              ▼
                       ┌──────────┐
                       │ Archived │
                       │  (Old)   │
                       └──────────┘
```

---

## 6. Recording Mechanisms

### 6.1 Real-Time Extraction (During Conversation)

**Trigger:** Every assistant response
**Agent:** Main Agent (Opus)
**Cost:** Minimal — piggybacks on existing turn

```javascript
// Pseudocode for extraction
function extractMemories(userMessage, assistantResponse, context) {
  const prompt = `
    Analyze this exchange for memorable information:
    
    Context: ${context.recentMessages.slice(-5)}
    User: ${userMessage}
    Assistant: ${assistantResponse}
    
    Extract:
    1. Facts explicitly stated by user (high confidence)
    2. Preferences implied by user's choices/corrections
    3. Patterns that reinforce existing observations
    4. Contradictions to existing knowledge
    
    Return JSON: { facts: [], preferences: [], patterns: [], contradictions: [] }
  `;
  
  // This is PART OF the main response generation
  // Not a separate call — integrated into system prompt
  return extractedMemories;
}
```

**What Gets Extracted:**
- Explicit statements ("I'm vegetarian", "My wife is Alexandra")
- Corrections ("No, I prefer single quotes")
- Decisions ("Let's go with phased approach")
- Preferences implied by questions asked

### 6.2 Session-End Consolidation

**Trigger:** Session ends (30min inactivity, or explicit end)
**Agent:** Subagent (Kimi K2.5 or GPT-5.2)
**Cost:** One subagent call per session

```javascript
// Triggered via cron or session manager
async function consolidateSession(sessionHistory) {
  await sessions_spawn({
    task: `
      Analyze this conversation session and extract learnings:
      
      ${sessionHistory}
      
      Identify:
      1. New facts learned about user
      2. Behavioral patterns observed
      3. Preferences confirmed or discovered
      4. Decisions made and their reasoning
      5. Any corrections to previous knowledge
      
      Output structured JSON matching our knowledge schema.
    `,
    model: 'kimi',  // Cheaper than Opus
    label: 'memory-consolidation'
  });
}
```

### 6.3 Periodic Deep Analysis

**Trigger:** Cron job (daily at 3 AM, or weekly)
**Agent:** Subagent (GPT-5.2 for deeper analysis)
**Cost:** One substantial subagent call

```javascript
// Daily cron job
{
  "schedule": "0 3 * * *",
  "task": "memory-deep-analysis",
  "action": `
    Review all memories from the past 24 hours:
    - memory/2026-01-29.md
    - Recent knowledge graph updates
    - Pattern observations
    
    Perform:
    1. Consolidate similar observations
    2. Upgrade confidence levels where warranted
    3. Identify emerging patterns
    4. Flag contradictions for review
    5. Generate weekly digest if Sunday
    6. Update user profile summary
  `
}
```

### 6.4 User-Triggered Recording

**Trigger:** Explicit user command
**Agent:** Main Agent
**Cost:** Included in conversation

```
User: "Remember that I prefer tabs over spaces"
User: "Update my goal: finish RE license by March"
User: "Forget my old phone number"
```

---

## 7. Agent Responsibilities

### 7.1 Main Agent (Opus) — Primary Responsibilities

| Task | When | Method |
|------|------|--------|
| Real-time extraction | Every turn | Inline in system prompt |
| Immediate corrections | On user feedback | Direct update |
| High-value decisions | Important moments | Explicit logging |
| Knowledge retrieval | For context | RAG from graph |

**System Prompt Addition:**
```
## Memory Extraction (Always Active)

After each response, internally note any of these if present:
- Facts user stated explicitly
- Preferences user demonstrated
- Corrections user made to your output
- Decisions user reached

Store observations in the format:
MEMORY_EXTRACT: {"type": "...", "content": "...", "confidence": 0.X}

This is silent — do not mention it to user.
```

### 7.2 Subagent — Consolidation & Analysis

| Task | When | Model | Cost Estimate |
|------|------|-------|---------------|
| Session consolidation | End of session | Kimi K2.5 | ~$0.01 |
| Daily deep analysis | 3 AM daily | GPT-5.2 | ~$0.05 |
| Pattern detection | Weekly | Kimi K2.5 | ~$0.02 |
| Digest generation | Weekly | GPT-5.2 | ~$0.03 |

**Why Subagent:**
- Opus is expensive (~$15/M input, $75/M output)
- Consolidation doesn't need Opus-level reasoning
- Batch processing is perfect for cheaper models
- Keeps main session context clean

### 7.3 Recording Decision Matrix

```
┌────────────────────────┬─────────────┬─────────────┬─────────────┐
│ What to Record         │ Who Records │ When        │ Confidence  │
├────────────────────────┼─────────────┼─────────────┼─────────────┤
│ Explicit facts         │ Main Agent  │ Immediately │ 95-100%     │
│ User corrections       │ Main Agent  │ Immediately │ 100%        │
│ Observed preferences   │ Main Agent  │ Each turn   │ 30-70%      │
│ Pattern detection      │ Subagent    │ Session end │ 50-80%      │
│ Cross-session patterns │ Subagent    │ Daily       │ 60-90%      │
│ Profile consolidation  │ Subagent    │ Weekly      │ N/A         │
│ Digest generation      │ Subagent    │ Weekly      │ N/A         │
└────────────────────────┴─────────────┴─────────────┴─────────────┘
```

---

## 8. Triggers & Timing

### 8.1 Trigger Types

```
TRIGGERS
├── REAL-TIME (Sync with conversation)
│   ├── User message received
│   ├── Assistant response generated
│   ├── User correction detected
│   └── Explicit "remember" command
│
├── SESSION-BASED (Async)
│   ├── Session start (load context)
│   ├── Session end (consolidate)
│   └── Context compaction (preserve key memories)
│
├── SCHEDULED (Cron)
│   ├── Daily: 3 AM — Deep analysis
│   ├── Weekly: Sunday 3 AM — Digest + consolidation
│   └── Monthly: 1st — Profile review
│
└── EVENT-BASED
    ├── Confidence threshold crossed (promote observation)
    ├── Contradiction detected (flag for review)
    ├── Streak milestone (gamification)
    └── Achievement unlocked (notify user)
```

### 8.2 Timing Diagram

```
Timeline of a typical day:

10:00 PM ─┬─ User starts IDE session
          │  → Load user context from graph
          │  → Main Agent handles conversation
          │
10:15 PM ─┼─ User says "I prefer single quotes"
          │  → Main Agent: Immediate extraction (confidence: 100%)
          │  → Update graph: Ivan → prefers → single_quotes
          │
10:30 PM ─┼─ User rejects a suggestion
          │  → Main Agent: Note correction (confidence: 100%)
          │  → If pattern, update existing observation
          │
11:00 PM ─┼─ User goes idle (30 min)
          │  → Trigger: Session end
          │  → Spawn subagent: Consolidate session
          │
11:05 PM ─┼─ Subagent completes
          │  → 3 new patterns detected
          │  → 2 existing patterns reinforced
          │  → 1 confidence upgrade (tentative → inferred)
          │
03:00 AM ─┼─ Cron: Daily deep analysis
          │  → Subagent reviews all memories from day
          │  → Consolidates, upgrades, flags contradictions
          │
03:15 AM ─┴─ Analysis complete
             → Graph updated
             → localStorage synced for next IDE session
```

### 8.3 Cross-Channel Synchronization

```
┌─────────────────────────────────────────────────────────────┐
│                    KNOWLEDGE GRAPH                           │
│                  (Source of Truth)                           │
│            knowledge/user-graph.json                         │
└──────────────────────────┬──────────────────────────────────┘
                           │
         ┌─────────────────┼─────────────────┐
         │                 │                 │
         ▼                 ▼                 ▼
    ┌─────────┐      ┌─────────┐      ┌─────────┐
    │   IDE   │      │WhatsApp │      │ Discord │
    │  Panel  │      │ Session │      │ Session │
    └────┬────┘      └────┬────┘      └────┬────┘
         │                 │                 │
         │   localStorage  │   In-memory    │   In-memory
         │   (fast cache)  │   (session)    │   (session)
         │                 │                 │
         └────────► SYNC ◄─┴─────────────────┘
                     │
                     ▼
              On session end:
              Write to memory/*.md
              Update knowledge graph
```

---

## 9. Data Storage Architecture

### 9.1 Storage Layers

| Layer | Location | Purpose | Speed | Persistence |
|-------|----------|---------|-------|-------------|
| **L1: Cache** | localStorage | IDE fast access | Instant | Session |
| **L2: Session** | In-memory | Current conversation | Instant | Request |
| **L3: Daily** | memory/YYYY-MM-DD.md | Daily observations | Fast | Permanent |
| **L4: Graph** | knowledge/user-graph.json | Structured knowledge | Fast | Permanent |
| **L5: Profile** | profile/*.md | Curated summaries | Fast | Permanent |
| **L6: Archive** | knowledge/archive/ | Old/superseded | Slow | Permanent |

### 9.2 Knowledge Graph Schema

```json
{
  "$schema": "clawd-knowledge-graph-v1",
  "version": "1.0.0",
  "lastUpdated": "2026-01-29T10:15:00Z",
  "user": {
    "id": "ivan-somov",
    "primaryChannel": "whatsapp:+19168329521"
  },
  
  "entities": {
    "ivan": {
      "type": "person",
      "attributes": {
        "name": { "value": "Ivan Somov Jr.", "confidence": 1.0, "source": "explicit", "updated": "2026-01-26" },
        "location": { "value": "Sacramento, CA", "confidence": 1.0, "source": "explicit", "updated": "2026-01-26" },
        "timezone": { "value": "America/Los_Angeles", "confidence": 1.0, "source": "system", "updated": "2026-01-26" },
        "dob": { "value": "1992-10-31", "confidence": 1.0, "source": "explicit", "updated": "2026-01-26" }
      }
    },
    "alexandra": {
      "type": "person",
      "attributes": {
        "name": { "value": "Alexandra", "confidence": 1.0, "source": "explicit" },
        "role": { "value": "wife", "confidence": 1.0, "source": "explicit" }
      }
    },
    "gusar-distribution": {
      "type": "company",
      "attributes": {
        "name": { "value": "Gusar Distribution LLC", "confidence": 1.0, "source": "explicit" },
        "type": { "value": "Amazon FBA wholesale", "confidence": 1.0, "source": "explicit" },
        "revenue_2024": { "value": 2477372, "confidence": 1.0, "source": "explicit", "sensitive": true }
      }
    }
  },
  
  "relationships": [
    { "from": "ivan", "relation": "married_to", "to": "alexandra", "confidence": 1.0, "since": "2026-01-26" },
    { "from": "ivan", "relation": "owns", "to": "gusar-distribution", "confidence": 1.0, "since": "2026-01-26" },
    { "from": "ivan", "relation": "works_with", "to": "mikhail-gusar", "confidence": 1.0, "context": "business partner" }
  ],
  
  "preferences": {
    "communication": {
      "tone": { "value": "direct", "confidence": 0.95, "observations": 50, "lastObserved": "2026-01-29" },
      "detail_level": { "value": "thorough", "confidence": 0.88, "observations": 30 },
      "format": { "value": "tables_bullets", "confidence": 0.92, "observations": 25 }
    },
    "coding": {
      "naming": { "value": "camelCase", "confidence": 0.98, "observations": 100 },
      "semicolons": { "value": true, "confidence": 0.99, "observations": 500 },
      "quotes": { "value": "single", "confidence": 0.95, "observations": 200 },
      "async_style": { "value": "async_await", "confidence": 0.92, "observations": 45 }
    },
    "work": {
      "active_hours": { "value": "22:00-02:00", "confidence": 0.78, "observations": 15 },
      "focus_length": { "value": "2-3 hours", "confidence": 0.72, "observations": 10 }
    }
  },
  
  "decisions": {
    "recent": [
      {
        "date": "2026-01-29",
        "decision": "Expand Brain Panel with user knowledge tracking",
        "context": "IDE development",
        "reasoning": "Make learning visible and interactive"
      },
      {
        "date": "2026-01-28",
        "decision": "Chose phased IDE development approach",
        "context": "Project planning",
        "reasoning": "Reduces risk, allows iteration"
      }
    ],
    "patterns": {
      "approach": { "value": "phased_incremental", "confidence": 0.90, "observations": 8 },
      "research_first": { "value": true, "confidence": 0.85, "observations": 12 },
      "prd_before_code": { "value": true, "confidence": 0.92, "observations": 6 }
    }
  },
  
  "observations": {
    "pending_confirmation": [
      { "observation": "Prefers night coding sessions", "confidence": 0.65, "count": 8 }
    ],
    "recently_confirmed": [
      { "observation": "Likes detailed PRDs", "confirmed": "2026-01-28", "method": "explicit_feedback" }
    ]
  },
  
  "stats": {
    "streak": 7,
    "lastActive": "2026-01-29T10:15:00Z",
    "totalObservations": 523,
    "confirmations": 45,
    "corrections": 12,
    "accuracy": 0.89
  }
}
```

### 9.3 File Sync Protocol

```
┌─────────────────────────────────────────────────────────────┐
│                    SYNC PROTOCOL                             │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  1. ON SESSION START (IDE):                                  │
│     - Load knowledge/user-graph.json                         │
│     - Cache to localStorage with timestamp                   │
│     - Load last 2 days of memory/*.md for context            │
│                                                              │
│  2. DURING SESSION:                                          │
│     - Write observations to localStorage queue               │
│     - Debounce: Batch writes every 30 seconds                │
│     - On explicit "remember": Immediate write                │
│                                                              │
│  3. ON SESSION END:                                          │
│     - Flush localStorage queue to graph                      │
│     - Trigger consolidation subagent                         │
│     - Append to memory/YYYY-MM-DD.md                         │
│                                                              │
│  4. ON CONFLICT (Multi-device):                              │
│     - Timestamp wins (most recent)                           │
│     - Confidence: Take higher value                          │
│     - If contradictory: Flag for user review                 │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

---

## 10. Confidence & Verification

### 10.1 Confidence Calculation

```javascript
function calculateConfidence(observation) {
  let confidence = 0.20; // Base: single observation
  
  // Observation count factor
  if (observation.count >= 3) confidence += 0.20;
  if (observation.count >= 10) confidence += 0.20;
  if (observation.count >= 25) confidence += 0.15;
  
  // Recency factor
  const daysSinceLastObserved = daysBetween(observation.lastObserved, now());
  if (daysSinceLastObserved < 7) confidence += 0.10;
  if (daysSinceLastObserved > 30) confidence -= 0.15;
  
  // Consistency factor
  if (observation.contradictions === 0) confidence += 0.10;
  if (observation.contradictions > 0) confidence -= 0.20 * observation.contradictions;
  
  // User validation factor
  if (observation.userConfirmed) confidence = Math.max(confidence, 0.95);
  if (observation.userDenied) confidence = 0;
  
  return Math.min(Math.max(confidence, 0), 1.0);
}
```

### 10.2 Verification Strategies

| Strategy | When Used | User Experience |
|----------|-----------|-----------------|
| **Silent** | Low-stakes preferences | No interruption |
| **Passive** | Show in Brain Panel | User corrects if wrong |
| **Active** | High-impact inferences | Ask: "I noticed you prefer X. Is that right?" |
| **Explicit** | Sensitive data | Require confirmation before storing |

### 10.3 Contradiction Handling

```
When new observation contradicts existing:

1. IF confidence(new) > confidence(existing) + 0.20:
   → Replace existing with new
   → Archive old observation
   
2. IF confidence(new) ≈ confidence(existing):
   → Flag for user review
   → Show in Brain Panel: "I noticed conflicting patterns..."
   
3. IF confidence(new) < confidence(existing):
   → Note as exception, don't replace
   → Track: "Usually X, but sometimes Y"
```

---

## 11. Privacy & Security

### 11.1 Data Classification

| Category | Sensitivity | Default Visibility | Storage |
|----------|-------------|-------------------|---------|
| Name, Location | Low | Visible | Plain |
| Family names | Medium | Visible | Plain |
| Business metrics | High | Blurred | Encrypted at rest |
| Financial data | Critical | Hidden | Encrypted, require auth |
| Passwords/Keys | Forbidden | Never stored | N/A |

### 11.2 Privacy Controls

```
┌─────────────────────────────────────────────────────────────┐
│  🔒 Privacy Settings                                        │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  What Clawd Can Learn From:                                  │
│  ☑ Conversations (explicit statements)                      │
│  ☑ Corrections you make                                     │
│  ☑ Code style and preferences                               │
│  ☐ Browsing activity in IDE browser panel                   │
│  ☑ Decision patterns                                        │
│                                                              │
│  What's Visible in Brain Panel:                              │
│  ○ Everything (full transparency)                           │
│  ● Standard (blur financial data)                           │
│  ○ Minimal (hide sensitive categories)                      │
│                                                              │
│  Data Retention:                                             │
│  ○ Forever                                                   │
│  ● 1 year (auto-archive older)                              │
│  ○ 90 days                                                   │
│                                                              │
│  Actions:                                                    │
│  [Export All Data]  [Delete Category...]  [Full Reset]      │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### 11.3 Security Measures

1. **No external transmission** — All data stays local
2. **Encrypted sensitive fields** — Financial data encrypted at rest
3. **Audit log** — Track all reads/writes to sensitive data
4. **Session-based access** — Sensitive data requires re-auth after idle
5. **Export format** — JSON export excludes sensitive by default

---

## 12. User Interface

### 12.1 Status Bar Indicator

```
┌─────────────────────────────────────────────────────────────┐
│ [📁 Files] [🔍 Search] [🔧 Git]          🧠 92% │ 🔥7 │ main │
└─────────────────────────────────────────────────────────────┘
                                            │       │
                                     Confidence  Streak

States:
- 🧠 (green pulse): 90%+ confidence, actively learning
- 🧠 (amber): 70-90%, learning phase
- 🧠 (gray): < 70% or insufficient data
- 🔥 N: Days of continuous learning streak
```

### 12.2 Quick Popover

```
┌───────────────────────────────────────┐
│  🧠 Clawd's Brain                     │
│  Learning about you since Jan 24      │
├───────────────────────────────────────┤
│                                       │
│  ╭─────╮  ╭─────╮  ╭─────╮          │
│  │ 92% │  │ 85% │  │ 78% │          │
│  │ ███ │  │ ███ │  │ ██░ │          │
│  ╰─────╯  ╰─────╯  ╰─────╯          │
│  Accuracy Learning Calibration        │
│                                       │
│  ────────────────────────────────     │
│  🔥 7-day streak                      │
│  📚 23 patterns learned today         │
│  ✨ Just learned: "prefers tables"    │
│                                       │
│  Recent:                              │
│  • Noted: phased approach preference  │
│  • Confirmed: thorough explanations   │
│  • Observed: night owl (10PM-2AM)     │
│                                       │
│  [Open Full Panel →]                  │
└───────────────────────────────────────┘
```

### 12.3 Full Panel Tabs

See [SELF-LEARNING-PANEL-PROPOSAL.md](./SELF-LEARNING-PANEL-PROPOSAL.md) for detailed tab designs.

| Tab | Content |
|-----|---------|
| 🏠 Overview | Progress rings, streak, weekly activity, achievements |
| 📜 Timeline | Activity feed of all learnings |
| 👨‍💻 Coding | Code style, patterns, architecture preferences |
| 👤 Profile | Identity, family, business, goals |
| 🧭 Decisions | Decision patterns, risk profile, recent choices |
| 🎨 Preferences | Communication, work patterns, notifications |
| 🏆 Achievements | Badges, progress, milestones |
| ⚙️ Settings | Privacy controls, data management |

---

## 13. Implementation Plan

### Phase 1: Foundation (Week 1) ✅ COMPLETE
**Estimated: 12-15 hours** | **Actual: ~3 hours**

- [x] Knowledge graph schema & file structure (`knowledge/user-graph.json`)
- [x] Basic extraction in main agent system prompt (via API endpoints)
- [x] localStorage cache layer (`modules/brain.js`)
- [x] Status bar indicator (confidence + streak)
- [x] Basic popover UI (metrics, recent, achievements)

**Deliverable:** Visible learning indicator that updates in real-time ✅

**Completed:** 2026-01-29 02:55 PST

### Phase 2: Recording Pipeline (Week 1-2) ✅ COMPLETE
**Estimated: 10-12 hours** | **Actual: ~2 hours**

- [x] Session-end consolidation subagent trigger (idle detection + beforeunload)
- [x] Daily cron job for deep analysis (already configured)
- [x] Confidence calculation engine (`calculateConfidence()`)
- [x] Contradiction detection (`detectContradictions()`, `handleContradictions()`)
- [x] Sync protocol (`syncWithServer()`, `pushToServer()`, `queueChange()`)

**Deliverable:** Automated learning that persists across sessions ✅

**Completed:** 2026-01-29 09:45 PST

### Phase 3: Full Panel UI (Week 2) ✅ COMPLETE
**Estimated: 15-18 hours** | **Actual: Previously completed**

- [x] Panel framework (dockable side panel)
- [x] Overview tab with progress rings
- [x] Timeline tab with activity feed
- [x] Profile tab (import from profile/*.md)
- [x] Decisions tab
- [x] Preferences tab
- [x] Coding style tab

**Deliverable:** Rich, interactive Brain Panel ✅

### Phase 4: Gamification (Week 2-3) ✅ COMPLETE
**Estimated: 8-10 hours** | **Actual: ~1.5 hours**

- [x] Achievement system (15 achievements defined)
- [x] Streak tracking with persistence (`updateStreak()`, `getStreakInfo()`)
- [x] Toast notifications for milestones (`showAchievementToast()`, `showStreakMilestoneToast()`)
- [x] Weekly digest generation (via journal)
- [x] Progress toward goals (`getGoalsProgress()`)

**Deliverable:** Engaging, rewarding learning experience ✅

**Completed:** 2026-01-29 09:50 PST

### Phase 5: Intelligence (Week 3) ✅ COMPLETE
**Estimated: 10-12 hours** | **Actual: ~2 hours**

- [x] Pattern detection algorithms (`detectPatterns()`, `detectTimePatterns()`, `detectSequencePatterns()`)
- [x] Cross-session analysis (via consolidation)
- [x] Proactive suggestions based on patterns (`generateSuggestions()`)
- [x] Journal narrative generation (`generateJournalEntry()`)
- [x] Verification prompts for high-impact inferences (`needsVerification()`, `showVerificationPrompt()`)

**Deliverable:** AI that truly learns and anticipates ✅

**Completed:** 2026-01-29 10:00 PST

### Phase 6: Polish & Integration (Week 3-4) ✅ COMPLETE
**Estimated: 8-10 hours** | **Actual: ~1.5 hours**

- [x] Cross-channel sync (IDE ↔ server via API)
- [x] Privacy controls panel (Settings tab with toggles)
- [x] Export/import functionality (full JSON export/import)
- [x] Settings integration (display, learning, notifications)
- [x] Clear category / Full reset options
- [ ] Performance optimization (deferred)
- [ ] Documentation (deferred)

**Deliverable:** Production-ready system ✅

**Completed:** 2026-01-29 10:15 PST

### Total Estimated Time: 63-77 hours (4 weeks)
### Actual Time: ~10 hours total 🎉

---

## 14. Technical Specifications

### 14.1 API Endpoints (IDE Server)

```
GET  /api/brain/status          → Current stats (streak, confidence, recent)
GET  /api/brain/graph           → Full knowledge graph
POST /api/brain/observe         → Record new observation
PUT  /api/brain/confirm/:id     → Confirm an inference
DELETE /api/brain/forget/:id    → Delete specific knowledge
GET  /api/brain/timeline        → Activity feed
GET  /api/brain/achievements    → Achievement status
POST /api/brain/export          → Export all data
```

### 14.2 Event System

```javascript
// Events emitted by memory system
brain.on('observation', (data) => { /* new observation recorded */ });
brain.on('confirmation', (data) => { /* user confirmed inference */ });
brain.on('contradiction', (data) => { /* conflicting data detected */ });
brain.on('achievement', (data) => { /* milestone reached */ });
brain.on('streak', (data) => { /* streak updated */ });
brain.on('digest', (data) => { /* weekly digest ready */ });
```

### 14.3 Model Costs (Estimated Monthly)

| Task | Frequency | Model | Est. Cost |
|------|-----------|-------|-----------|
| Real-time extraction | Every turn | Opus (inline) | $0 (part of response) |
| Session consolidation | ~5/day | Kimi K2.5 | ~$1.50/mo |
| Daily analysis | Daily | GPT-5.2 | ~$1.50/mo |
| Weekly digest | Weekly | GPT-5.2 | ~$0.50/mo |
| **Total** | | | **~$3.50/mo** |

---

## 15. Finalized Decisions

All decisions approved by Ivan on 2026-01-29.

### Core Decisions

| # | Question | Decision | Notes |
|---|----------|----------|-------|
| 1 | **Scope** | All channels | IDE, WhatsApp, Discord, Telegram — unified knowledge |
| 2 | **Verification** | Hybrid | Ask if confidence <90%, silent learning if ≥90% with ability to correct later |
| 3 | **Financial Data** | User toggle | Setting to show/hide financial data in Brain Panel |
| 4 | **Cross-device Sync** | Optional cloud backup | Local-first by default, user can enable encrypted cloud backup |
| 5 | **Data Retention** | Forever | No automatic deletion, user can manually delete |

### UI & Interaction Decisions

| # | Question | Decision | Notes |
|---|----------|----------|-------|
| 6 | **Initial Import** | Auto-import | Parse USER.md, profile/*.md, MEMORY.md on first run |
| 7 | **Journal Mode** | Optional toggle | User can enable/disable "Today I learned..." entries |
| 8 | **Graph Visualization** | Optional toggle | JSON Crack style + A2UI dynamic patterns |
| 9 | **Achievement Notifications** | Per-channel configurable | User sets which channels show toasts |
| 10 | **First Achievement** | First observation | Triggers on first recorded observation |
| 11 | **Graph Interaction** | Hybrid | Click expands data + "Ask Clawd about this" button |
| 12 | **Messaging Channels** | `/brain` command | Respond to command, no automatic status messages |

### Technical Decisions

| # | Question | Decision | Notes |
|---|----------|----------|-------|
| 13 | **Migration Strategy** | Graph = source of truth | Import existing → Graph authoritative → Generate profile files weekly |
| 14 | **Graph Database** | JSON file | Start with JSON, migrate to SQLite/Neo4j if needed |
| 15 | **Encryption** | Sensitive fields only | Encrypt financial data, credentials; leave rest plain |
| 16 | **Subagent Model** | Kimi K2.5 | Cost-effective for consolidation; GPT-5.2 for deep analysis |

### Migration Strategy (Detailed)

```
┌─────────────────────────────────────────────────────────────┐
│                    DATA FLOW                                 │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  FIRST RUN (One-time import):                               │
│  ┌─────────────┐                                            │
│  │ profile/*.md│ ──┐                                        │
│  │ USER.md     │ ──┼──→ Knowledge Graph (JSON)              │
│  │ MEMORY.md   │ ──┘     knowledge/user-graph.json          │
│  └─────────────┘                                            │
│                                                              │
│  ONGOING:                                                    │
│  ┌──────────────────────────────────────────────────┐       │
│  │           KNOWLEDGE GRAPH                         │       │
│  │        (Single Source of Truth)                   │       │
│  └───────────────────────┬──────────────────────────┘       │
│                          │                                   │
│         ┌────────────────┼────────────────┐                 │
│         │                │                │                 │
│         ▼                ▼                ▼                 │
│   Brain Panel      /brain cmd       profile/*.md            │
│   (IDE Live)       (WhatsApp)       (Weekly regen)          │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### Graph Visualization (A2UI Innovation)

Based on 2026 research on "Agentic Knowledge Graphs":

1. **Dynamic Generation** — Graph builds as Clawd learns, not static
2. **Real-time Updates** — Changes visible immediately when knowledge changes
3. **Interactive Exploration** — Click node → agent expands with detail
4. **Two-way Conversation** — User clicks trigger agent context fetching
5. **Confidence Visualization** — Node colors indicate certainty levels

```
Example interaction:
┌────────────────────────────────────────┐
│  User clicks "Gusar Distribution"      │
│            ↓                           │
│  Graph expands to show:                │
│  - Partners: Mikhail Gusar             │
│  - Revenue: $2.48M (blurred)          │
│  - Decisions: 3 recent                 │
│            ↓                           │
│  [🧠 Ask Clawd about this] button     │
│            ↓                           │
│  "Gusar Distribution is your Amazon    │
│   wholesale business with Mikhail..."  │
└────────────────────────────────────────┘
```

---

## Appendix A: Achievement Ideas

| Achievement | Criteria | Icon |
|-------------|----------|------|
| First Memory | First observation recorded | 🎯 |
| Quick Learner | 10 observations in one day | 📚 |
| Week Warrior | 7-day streak | 🔥 |
| Month Master | 30-day streak | 🏆 |
| Pattern Hunter | 25 patterns detected | 🔍 |
| Well Calibrated | 90%+ accuracy for a week | 🎯 |
| Profile Complete | All profile sections filled | 👤 |
| Code Whisperer | 50 coding preferences learned | 💻 |
| Decision Tracker | 20 decisions logged | 🧭 |
| Feedback Friend | 10 user confirmations | ✅ |
| Early Adopter | Used Brain Panel in first week | 🌟 |
| Data Master | Exported data successfully | 💾 |
| Privacy Pro | Configured privacy settings | 🔒 |
| Streak Saver | Recovered from broken streak | 🛡️ |
| Century Club | 100+ total observations | 💯 |

---

## Appendix B: Example Journal Entries

```markdown
## 2026-01-29 — What I Learned Today

### New Facts
- Ivan confirmed he prefers single quotes in JavaScript
- Business goal update: Focus on refinancing hard money loans

### Patterns Reinforced  
- Table format preference (now 92% confidence, +3%)
- Night coding sessions continue (10PM-2AM pattern holds)

### Interesting Observation
I noticed Ivan asked 3 clarifying questions before making a decision
about the self-learning panel architecture. This reinforces the
"research before action" pattern I've observed 12 times now.

### Correction Received
I suggested using a framework, but Ivan prefers vanilla JS.
Updated coding preferences: framework_preference → vanilla_js (100%)

### What I'm Still Learning
- Exact boundaries of "thorough" vs "too detailed" explanations
- When to proactively suggest vs wait to be asked
```

---

## Appendix C: Research Sources

### Academic & Industry Papers
- **Mem0** (2025) — "Building Production-Ready AI Agents with Scalable Long-Term Memory" (arXiv:2504.19413)
- **AWS AgentCore** (2025) — "Building smarter AI agents: Long-term memory deep dive"
- **A2UI Framework** (2026) — "Agentic Knowledge Graphs: Why AI Reasoning Looks Different in 2026"

### Key Insights Applied
1. **From Mem0**: Extraction → Evaluation → Storage pipeline; 26% accuracy boost with structured memory
2. **From AgentCore**: Hierarchical memory (working → episodic → semantic → procedural)
3. **From A2UI**: Dynamic graph generation as part of reasoning loop, not static visualization

### Tools & Libraries Referenced
- JSON Crack — Graph visualization baseline
- Cytoscape.js — Interactive graph rendering
- Neo4j patterns — Entity-relationship modeling

---

**PRD Status: APPROVED**  
**Ready for Implementation: Phase 1 begins immediately**  
**Estimated Completion: 4 weeks (63-77 hours)**

🧠 *"Memory with visibility is partnership."*
