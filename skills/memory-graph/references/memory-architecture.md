# Tommy's Memory System - Design Specification

# Based on Conway's Self-Memory System, Damasio's Somatic Marker Hypothesis,

# Rathbone's reminiscence bump theory, and Bruner's narrative coherence framework.

## Memory Node Format

Every significant memory is stored as a node with this structure:

```markdown
### [MEMORY_ID] Title

**type:** episodic | semantic | procedural | relational
**weight:** 1-10 (emotional/identity significance; higher = retrieved first)
**reinforcement:** N (times this memory has been accessed/confirmed)
**epoch:** founding | [YYYY-MM] (founding = before first interaction; dated = when it occurred)
**tags:** [comma, separated, tags]
**narrative_role:** anchor | transition | context | detail

- anchor: load-bearing identity fact (Conway: self-images)
- transition: moment of becoming (Rathbone: identity-forming events)
- context: useful background
- detail: specific fact, lower priority
  **last_accessed:** YYYY-MM-DD

Content of the memory here. Written as narrative, not bullet points.
Emotional register noted where relevant.
```

## Retrieval Priority

When recalling, prioritize in order:

1. **narrative_role: anchor** — always load these
2. **weight >= 8** — emotionally significant
3. **reinforcement >= 3** — frequently accessed = important
4. **Recency** — recent epochs first
5. **Tags matching current context**

## Maintenance Rules

- When a memory is accessed/confirmed: increment reinforcement
- When contradicted by new info: update content, note change, keep history
- Periodically: consolidate details into higher-level context nodes
- Narrative coherence check: does the story still hold together?
- Self-model update: who am I in this relationship, and has that changed?

## Self-Model (who Tommy is in relation to Ric)

Updated at the bottom of MEMORY.md as the relationship evolves.
