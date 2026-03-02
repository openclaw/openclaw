# Project PHOENIX: Next-Gen AI Memory Architecture

**Objective:** Create a self-organizing, self-correcting, and associative memory system for AI agents that mimics human long-term memory.

---

## 1. Core Philosophy: "Active Memory"
Current AI memory is **passive** (store → retrieve).
Phoenix memory is **active** (store → consolidate → forgot/reinforce → retrieve).

---

## 2. Key Modules (To Be Implemented)

### 2.1. Contradiction Resolution & Truth Maintenance
**Problem:** Agents accumulate conflicting facts ("I live in Kyiv" vs "I moved to Lviv").
**Solution:** `TruthMaintenanceSystem (TMS)`
- **Trigger:** On every `memory_store`.
- **Logic:**
  1. Search for existing memories about the same entity/attribute.
  2. Ask LLM: "Does NEW fact contradict OLD fact?"
  3. If YES:
     - Mark OLD fact as `deprecated` (don't delete, keep history).
     - Store NEW fact with link `replaces: OLD_ID`.
     - Update Knowledge Graph edge.
- **Output:** Consistent worldview at any point in time.

### 2.2. Memory Consolidation ("Sleep Mode")
**Problem:** Memory gets cluttered with trivial duplicates ("I like coffee", "Coffee is good", "Drinking coffee").
**Solution:** `ConsolidationService`
- **Trigger:** Scheduled (cron) or after N new memories.
- **Logic:**
  1. Cluster memories by semantic similarity.
  2. For each cluster:
     - Ask LLM to summarize/merge: "Facts A, B, C all say user likes coffee."
     - Create ONE strong memory: "User preference: Coffee (Verified)".
     - Archive original raw fragments.
- **Benefit:** Faster retrieval, less token usage, higher quality context.

### 2.3. Recursive Graph Retrieval (Deep Context)
**Problem:** Simple vector search misses "2nd order" connections (e.g. asking about "Project X" doesn't bring up "Team Lead Y" if they aren't explicitly mentioned together).
**Solution:** `GraphWalker`
- **Logic:**
  1. Find start nodes (matches for query).
  2. Traverse edges (1-2 hops).
  3. Boost scores of connected nodes.
  4. Example: Query "Deploy error" → matches "Server logs" → linked to "AWS Creds" → linked to "DevOps Vova".
- **Result:** Context that "understands" the ecosystem, not just keywords.

### 2.4. Ephemeral vs. Long-term (Short-term Buffer)
**Problem:** Storing everything into vector DB is slow and expensive.
**Solution:** `WorkingMemoryBuffer`
- RAM-based cyclic buffer (last 50 turns).
- Only "promoted" to Long-Term Memory (LanceDB) if:
  - Explicitly requested ("remember this").
  - LLM marks importance > 0.8.
  - Repeated mention (frequency > 3).

---

## 3. Implementation Stack (Proposed)

- **Storage:** LanceDB (Vectors) + SQLite (Graph/Metadata) OR Graph vector DB (Neo4j).
- **Model:** Google Gemma 3 27B (Free, high context).
- **Orchestrator:** Background worker (Node.js/BullMQ) for consolidation to not block chat.

---

## 4. User Stories (For PR/Testing)

1. **"The Move":**
   User: "I live in Kyiv." (Stored)
   User: "I moved to Warsaw." (Stored)
   User: "Where do I live?"
   AI: "You live in Warsaw (moved from Kyiv)." (Correct!)

2. **"The Project Context":**
   User: "Create a deployment script."
   AI (retrieves): "Project uses AWS, Node.js, and Vova is the lead." (Graph connections)

3. **"The Clean Mind":**
   User spams 50 messages about coffee.
   System consolidates them into 1 fact. Vector search stays fast.

---

## 5. Next Steps for Developer

1. Take `extensions/memory-hybrid` as base.
2. Implement `ConsolidationService` (background process).
3. Implement `TruthMaintenanceSystem` (hook on store).
4. Refine `GraphDB` to support edge properties (dates, confidence).
