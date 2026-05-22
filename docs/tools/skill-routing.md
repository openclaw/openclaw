---
summary: "How the local skill router shortlists matching SKILL.md files for an agent run"
read_when:
  - You want to understand how local_skill_route works
  - You are debugging why an agent did or did not read a skill
  - You are scaling a workspace with many skills
title: "Skill routing"
sidebarTitle: "Skill routing"
---

Skill routing helps an agent choose a relevant `SKILL.md` without guessing a
path or reading several unrelated skills. OpenClaw exposes the
`local_skill_route` runtime tool when the current run has a skill snapshot. The
agent can call it with the user's task, receive a ranked shortlist, and then
read exactly one matching skill when the result is clear.

The router is local, read-only, and deterministic. It does not call an external
rerank service, run another model, or replace skill allowlists. It is a compact
foundation for large workspaces where sending every skill description directly
to the model is increasingly expensive.

## When the router appears

OpenClaw registers `local_skill_route` only when the agent tool set receives a
`skillsSnapshot` for the current run. That keeps the prompt and tool surface in
sync:

- If the tool is registered, the Skills prompt can tell the model to call
  `local_skill_route` when skill choice is unclear.
- If the tool is not registered, the prompt falls back to scanning the visible
  `<available_skills>` catalog and never mentions the router.
- If no skills are available, the router is omitted entirely.

Sandboxed runs that intentionally do not carry a skill snapshot still get the
normal visible skills prompt when OpenClaw can build one from loaded entries,
but they do not receive `local_skill_route`.

## What the tool receives

The tool accepts the current task as a short query:

```json
{
  "query": "schedule a calendar meeting tomorrow",
  "limit": 5
}
```

`query` is required. `limit` is optional, defaults to `5`, and is capped at
`10`.

## What the tool returns

The result is JSON with one of three statuses:

- `matched`: one skill is clearly strongest. The instruction tells the agent to
  read that skill's `SKILL.md` location before using it.
- `ambiguous`: two or more strong matches are close together. The agent should
  ask the user to choose, or use task context to pick the most specific match.
- `nomatch`: no candidate is strong enough. The agent should not read a skill
  unless the user gives more specific context.

Example result:

```json
{
  "status": "matched",
  "query": "schedule a calendar meeting tomorrow",
  "instruction": "Read /workspace/skills/calendar/SKILL.md before using the skill.",
  "matches": [
    {
      "name": "calendar",
      "description": "Create and update calendar events and meetings",
      "location": "/workspace/skills/calendar/SKILL.md",
      "score": 0.72
    }
  ]
}
```

The router returns skill names, descriptions, locations, and scores. It does not
return skill body text. The agent still must use the normal read tool to load
`SKILL.md`.

## How matching works

The current router uses lexical scoring:

1. Normalize the query, skill name, and skill description with lowercase NFKC
   text.
2. Tokenize letters and numbers.
3. Boost matches in the skill name more than matches in the description.
4. Add a smaller score for partial token overlap.
5. Sort by score, then by skill name for deterministic ties.
6. Classify the result as `matched`, `ambiguous`, or `nomatch` with fixed local
   thresholds.

This makes routing stable and cheap. It also means the router is not semantic:
if a task uses words that do not overlap a skill name or description, the tool
may return `nomatch`. Good skill names and concise descriptions matter.

## Prompt behavior

When skills are present, OpenClaw still includes the normal Skills section. The
router changes the decision path, not the read contract:

1. The agent scans the visible skill catalog.
2. If one skill clearly applies, it can read that `SKILL.md` directly.
3. If the choice is unclear and `local_skill_route` is available, it calls the
   router with the user's request.
4. It reads at most one matching `SKILL.md` up front.
5. It never invents skill paths.

The current router does not remove the visible `<available_skills>` catalog
from the system prompt. That larger prompt-size optimization needs a separate
design because it changes model behavior for every skill-enabled run.

## Debug routing

If an agent does not use the expected skill:

1. Confirm the skill is visible to that agent. See [Skills](/tools/skills) for
   roots, precedence, and allowlists.
2. Check whether `local_skill_route` is present in the run's tool list. If it is
   missing, the run did not receive a skill snapshot.
3. Check the skill's `name` and `description`. The router matches those fields,
   not the full `SKILL.md` body.
4. Try a query that includes the expected skill name or description terms.
5. If two skills are close, expect `ambiguous` and make the skill names or
   descriptions more specific.

## Related

- [Skills](/tools/skills) for load order, allowlists, and snapshots
- [Creating skills](/tools/creating-skills) for writing clear skill names and
  descriptions
- [Skills config](/tools/skills-config) for configuration fields
- [Tool Search](/tools/tool-search) for compact discovery across large PI tool
  catalogs
