---
name: meta-skill-creator
description: "Create governed Skill Workshop proposals for reusable workflows."
kind: meta
triggers: ["create a skill", "make a skill", "turn this workflow into a skill"]
composition:
  {
    "steps":
      [
        {
          "id": "collect",
          "kind": "user_input",
          "schema": { "required": ["name", "description", "workflow", "content"] },
        },
        {
          "id": "proposal",
          "kind": "tool_call",
          "depends_on": ["collect"],
          "tool": "meta_skill_creator",
          "args":
            {
              "name": "{{collect.name}}",
              "description": "{{collect.description}}",
              "content": "{{collect.content}}",
              "goal": "Created by meta-skill-creator",
              "evidence": "creator workflow collected: {{collect.workflow}}",
            },
        },
      ],
  }
final_text_mode: step:proposal
---

# Meta Skill Creator

Create pending Skill Workshop proposals for reusable workflows from provided
proposal content. Do not write active `SKILL.md` files directly.
