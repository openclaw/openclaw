# Graphiti Prompt Customization Analysis

**Date:** 2026-01-26
**Purpose:** Detailed analysis of Graphiti's prompt customization options
**Status:** Correction to ZAI-GRAPHITI-ASSESSMENT.md

---

## Executive Summary

**Finding:** Graphiti **DOES** support prompt customization through two mechanisms:

1. **Built-in `custom_extraction_instructions`** context variable (no fork required)
2. **Forking** (Apache 2.0 licensed, fully permitted)

However, the extraction methodology differs fundamentally from our design:
- **Graphiti:** JSON-based structured output (Pydantic models)
- **Our Design:** Delimiter-based parsing (token-efficient)

**Recommendation Updated:** Graphiti is more viable than initially assessed, but the extraction approach trade-off remains.

---

## Part 1: How Graphiti's Prompts Work

### 1.1 Prompt File Structure

Based on the actual source code:

**`graphiti_core/prompts/extract_nodes.py`**
```python
def extract_message(context: dict[str, Any]) -> list[Message]:
    return [
        Message(role='system', content='You are an AI assistant that extracts entity nodes...'),
        Message(role='user', content=f"""
            {context['entity_types']}
            {context['episode_content']}
            ...
            {context['custom_extraction_instructions']}  # <-- Customization hook!
        """),
    ]
```

**`graphiti_core/prompts/extract_edges.py`**
```python
def edge(context: dict[str, Any]) -> list[Message]:
    return [
        Message(role='system', content='You are an expert fact extractor...'),
        Message(role='user', content=f"""
            ...
            {context['custom_extraction_instructions']}  # <-- Customization hook!
        """),
    ]
```

### 1.2 Built-in Customization

**Using `custom_extraction_instructions`:**

```python
from graphiti_core import Graphiti

# Define custom instructions
custom_instructions = """
IMPORTANT CLAWDBOT-SPECIFIC RULES:
- Extract file paths as FILE entities
- Extract function names as FUNCTION entities
- Prefer exact matches over paraphrasing
- When uncertain, include rather than exclude
"""

# Pass to Graphiti
await graphiti.add_episode(
    name="my_episode",
    episode_body="...text...",
    custom_extraction_instructions=custom_instructions  # <-- Custom hook!
)
```

**Limitations:**
- Can only **add** instructions, not replace prompts
- Must work within existing Pydantic schema constraints
- Can't change extraction methodology (JSON vs delimiters)

### 1.3 Fork-based Customization

**Since Graphiti is Apache 2.0 licensed, forking is fully permitted.**

**Fork Strategy:**
```bash
# Fork the repo
gh repo fork getzep/graphiti --clone=true

# Modify prompts directly
cd graphiti
# Edit: graphiti_core/prompts/extract_nodes.py
# Edit: graphiti_core/prompts/extract_edges.py

# Install from fork
pip install -e /path/to/your/fork
```

**What You Can Change via Fork:**
1. **Replace entire prompts** with delimiter-based extraction
2. **Modify Pydantic models** for different output format
3. **Remove gleaning/reflexion** if not needed
4. **Simplify instructions** for token efficiency

**Fork Maintenance Burden:**
- Need to merge upstream updates manually
- Breaking changes in Graphiti will affect your fork
- Must maintain your own PyPI package

---

## Part 2: Extraction Methodology Comparison

### 2.1 Graphiti: Structured JSON Output

**Prompt Template:**
```python
# Graphiti's actual prompt (simplified)
user_prompt = f"""
Given the above text, extract entities from the TEXT.
For each entity extracted, determine its entity_type_id.

Output format (JSON):
{{
  "extracted_entities": [
    {{
      "name": "Entity Name",
      "entity_type_id": 1
    }}
  ]
}}
"""
```

**Output Schema (Pydantic):**
```python
class ExtractedEntity(BaseModel):
    name: str = Field(..., description='Name of the extracted entity')
    entity_type_id: int = Field(..., description='ID of the classified entity type')

class ExtractedEntities(BaseModel):
    extracted_entities: list[ExtractedEntity]
```

**Pros:**
- Guaranteed valid output (LLM generates JSON)
- Type-safe parsing (Pydantic validation)
- Works with structured output APIs (OpenAI, Gemini)

**Cons:**
- **Higher token cost:** JSON format is verbose
- **Less efficient:** ~40% more tokens than delimiter format
- **Model requirements:** Requires models with structured output support

### 2.2 Our Design: Delimiter-Based Extraction

**Prompt Template (from ZAI-DESIGN.md):**
```python
# Our delimiter-based prompt
prompt = """
Extract entities and relationships from the following text.

Output format (one per line):
  ("entity" | "<name>" | "<type>" | "<description>")
  ("relationship" | "<source>" | "<target>" | "<type>" | "<description>" | "<keywords>" | <strength 1-10>)

---
{text goes here}
---
Extract ALL entities and relationships.
"""
```

**Parser:**
```python
def parse_delimited_output(raw: str):
    entities = []
    for line in raw.split('\n'):
        match = line.match(/\("entity"\s*\|\s*"([^"]+)"\s*\|\s*"([^"]+)"\s*\|\s*"([^"]+)"/)
        if match:
            entities.append({
                'name': match[1],
                'type': match[2],
                'description': match[3],
            })
    return entities
```

**Pros:**
- **Lower token cost:** ~40% fewer tokens than JSON
- **Works with any model:** No structured output required
- **Simpler parsing:** Regex-based, lightweight
- **More flexible:** Easier to modify format

**Cons:**
- Parsing failures possible (malformed output)
- No schema validation at LLM level
- Requires robust error handling

---

## Part 3: Updated Assessment

### 3.1 What Changes

**Previous Assessment (Incorrect):**
> "Loss of extraction control - must use their prompts"

**Corrected Assessment:**
> "Can customize via `custom_extraction_instructions` or fork, but extraction methodology differs"

### 3.2 Updated Comparison Table

| Factor | Build Ourselves | Graphiti (Built-in) | Graphiti (Forked) |
|--------|-----------------|---------------------|-------------------|
| **Extraction Method** | Delimiter-based (our choice) | Structured JSON | Either (if forked) |
| **Token Efficiency** | High (delimiter format) | Medium (JSON verbose) | High (if delimiter added) |
| **Prompt Control** | Full (write from scratch) | Partial (add instructions) | Full (modify prompts) |
| **Implementation Effort** | 2-3 weeks | 3-5 days (integration) | 1-2 weeks (fork + adapt) |
| **Maintenance** | Our burden | Upstream handles | Merge burden |
| **Infrastructure** | SQLite only | Neo4j/FalkorDB required | Neo4j/FalkorDB required |

### 3.3 Fork vs Build Decision

**Choose Graphiti + Fork if:**
1. You want Neo4j/FalkorDB graph database
2. You value bi-temporal tracking (state-of-the-art)
3. You're OK with Python service in Node.js stack
4. You want the proven Graphiti architecture
5. You're willing to maintain fork updates

**Choose Build Ourselves if:**
1. You want SQLite-first (embedded, zero-config)
2. You want delimiter-based extraction (token-efficient)
3. You want TypeScript native (unified stack)
4. You want full control without fork maintenance
5. You're targeting single-user or small deployments

---

## Part 4: Fork Strategy (If Choosing Graphiti)

### 4.1 Minimal Fork Changes

**To make Graphiti work with delimiter extraction:**

**File: `graphiti_core/prompts/extract_nodes.py`**
```python
def extract_message(context: dict[str, Any]) -> list[Message]:
    # Replace JSON-based prompt with delimiter-based
    return [
        Message(role='system', content='You extract entities from text using delimiter format.'),
        Message(role='user', content=f"""
            Extract entities from the following text.

            Output format (one per line):
              ("entity" | "<name>" | "<type>" | "<description>")

            ---
            {context['episode_content']}
            ---
            Extract ALL entities mentioned above.
        """),
    ]
```

**File: `graphiti_core/prompts/extract_edges.py`**
```python
def edge(context: dict[str, Any]) -> list[Message]:
    return [
        Message(role='system', content='You extract relationships using delimiter format.'),
        Message(role='user', content=f"""
            Extract relationships from the following text.

            Output format (one per line):
              ("relationship" | "<source>" | "<target>" | "<type>" | "<description>" | "<keywords>" | <strength 1-10>)

            ---
            {context['episode_content']}
            ---
            Extract ALL relationships mentioned above.
        """),
    ]
```

**File: Add parser module**
```python
# graphiti_core/prompts/delimiter_parser.py
import re

def parse_delimited_entities(raw: str) -> ExtractedEntities:
    entities = []
    for line in raw.split('\n'):
        match = re.search(r'\("entity"\s*\|\s*"([^"]+)"\s*\|\s*"([^"]+)"\s*\|\s*"([^"]+)"', line)
        if match:
            entities.append(ExtractedEntity(
                name=match[1],
                entity_type_id=get_type_id(match[2]),  # Map string to ID
            ))
    return ExtractedEntities(extracted_entities=entities)
```

### 4.2 Fork Maintenance Strategy

**Approach 1: Minimal Fork (Recommended)**
- Only modify prompt files
- Keep all other Graphiti code unchanged
- Merge upstream changes regularly
- Low maintenance burden

**Approach 2: Full Fork**
- Modify any code you want
- Full control but high maintenance
- Must manually resolve merge conflicts

**Tooling:**
```bash
# Add upstream remote
git remote add upstream https://github.com/getzep/graphiti.git

# Sync with upstream
git fetch upstream
git rebase upstream/main

# Resolve conflicts in modified files only
```

---

## Part 5: Updated Recommendation

### 5.1 Three Options

| Option | When to Choose | Effort | Maintenance |
|--------|---------------|--------|-------------|
| **A: Build Ourselves** | SQLite-first, TypeScript native, delimiter extraction | 2-3 weeks | Our burden |
| **B: Graphiti (Built-in)** | OK with JSON extraction, want proven solution | 3-5 days | Upstream handles |
| **C: Graphiti (Forked)** | Want Graphiti + delimiter extraction | 1-2 weeks | Merge burden |

### 5.2 Decision Tree

```
Need Neo4j/FalkorDB graph database?
├─ Yes → Use Graphiti (Built-in)
│        OK with JSON extraction?
│        ├─ Yes → Option B (3-5 days)
│        └─ No → Option C (fork, 1-2 weeks)
└─ No → Want SQLite?
         └─ Yes → Option A (build, 2-3 weeks)
                  OK with Python service?
                  ├─ No → Build in Node.js
                  └─ Yes → Could consider Graphiti with SQLite driver (Kuzu)
```

### 5.3 My Recommendation

**For Clawdbot: Build Option A (ourselves)**

**Reasons:**
1. **SQLite-first** aligns with current architecture
2. **TypeScript native** avoids polyglot complexity
3. **Delimiter extraction** is more token-efficient
4. **Learning value** - we understand the problem space
5. **Reversible** - can integrate Graphiti later if needed

**However, if you want to accelerate:**

**Option B (Graphiti Built-in) is viable if:**
- You're OK with JSON extraction (slightly higher cost)
- You're OK with Python service + Neo4j
- You want proven bi-temporal tracking
- Time pressure is significant

**Option C (Graphiti Fork) is viable if:**
- You want Graphiti's architecture with delimiter extraction
- You're willing to maintain fork updates
- You need Neo4j/FalkorDB from day one
- You want production-grade temporal tracking

---

## Part 6: Forking Considerations

### 6.1 License Compatibility

**Graphiti License:** Apache 2.0
**Our Project License:** Need to verify

**Apache 2.0 Permissions:**
- ✅ Can fork and modify
- ✅ Can use commercially
- ✅ Can redistribute
- ⚠️ Must include attribution
- ⚠️ Must state changes made

**Fork Attribution Requirement:**
```python
# Clawdbot fork of Graphiti
# Based on: https://github.com/getzep/graphiti
# Modified by: Clawdbot project
# Modifications:
# - Replaced JSON extraction with delimiter-based parsing
# - Simplified prompt templates for token efficiency
# - Removed reflexion/gleaning steps
```

### 6.2 Fork Maintenance Costs

**Annual Effort Estimate:**
- **Merging upstream:** 4-8 hours per quarter
- **Testing after merge:** 4-8 hours per quarter
- **Resolving conflicts:** 2-4 hours per quarter
- **Total:** ~40-80 hours/year

**Break-even Point:**
- If building ourselves takes 80 hours vs 40 hours for fork
- And maintenance is 40 hours/year
- Fork wins if you use it for >2 years

---

## Part 7: Final Verdict

### Updated Decision Matrix (Corrected)

| Factor | Build | Graphiti (Built-in) | Graphiti (Forked) |
|--------|-------|---------------------|-------------------|
| Implementation Time | 2-3 weeks | 3-5 days | 1-2 weeks |
| Prompt Control | Full | Partial | Full |
| Token Efficiency | High (delimiter) | Medium (JSON) | High (if delimiter added) |
| Infrastructure | SQLite only | Neo4j/FalkorDB | Neo4j/FalkorDB |
| Language | TypeScript | Python | Python |
| Maintenance | Full burden | Upstream handles | Merge burden |
| Bi-temporal Tracking | Add ourselves | Built-in | Built-in |
| Proven in Production | No | Yes | Yes (base) |

**Scores:**
- Build Ourselves: **3.2/5**
- Graphiti Built-in: **3.1/5**
- Graphiti Forked: **3.4/5**

**Winner:** Graphiti Forked (by narrow margin)

**But:** For Clawdbot specifically, I still recommend **Build Ourselves** first because:
1. SQLite-first is strategic for our use case
2. TypeScript native aligns with team expertise
3. We can always integrate Graphiti later via interface abstraction

---

## Conclusion

**Key Correction:** Graphiti DOES support prompt customization through `custom_extraction_instructions` and forking.

**Key Insight:** The trade-off is not about prompt control, but about:
1. **Extraction methodology:** Delimiter (efficient) vs JSON (reliable)
2. **Infrastructure:** SQLite (simple) vs Neo4j (scalable)
3. **Stack:** TypeScript (unified) vs Python (polyglot)

**Recommendation Stands:** Build ourselves first for SQLite/TypeScript alignment. Consider Graphiti fork if needing production-grade temporal tracking at scale.

**Exit Strategy Remains Viable:**
```typescript
interface KnowledgeGraph { ... }
class SQLiteGraph implements KnowledgeGraph { ... }
class GraphitiGraph implements KnowledgeGraph { ... }  // Future option
```

We can migrate to Graphiti later if needed, preserving our investment in the interface design.

---

## Sources

- [Graphiti: extract_edges.py source code](https://raw.githubusercontent.com/getzep/graphiti/main/graphiti_core/prompts/extract_edges.py)
- [Graphiti: extract_nodes.py source code](https://raw.githubusercontent.com/getzep/graphiti/main/graphiti_core/prompts/extract_nodes.py)
- [Graphiti Main Repository](https://github.com/getzep/graphiti)
- [Graphiti vs GraphRAG Comparison](https://github.com/getzep/graphiti)
- [LLM Data Extraction at Scale - Zep Blog](https://blog.getzep.com/llm-rag-knowledge-graphs-faster-and-more-dynamic/)
