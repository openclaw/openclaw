---
name: meta-skill-creator
description: "Create governed Skill Workshop proposals for reusable workflows."
kind: meta
triggers: ["create a skill", "make a skill", "turn this workflow into a skill"]
risk_metadata:
  {
    "level": "medium",
    "notes": ["creates pending Skill Workshop proposals only", "does not apply active skills"],
  }
composition:
  {
    "steps":
      [
        {
          "id": "collect",
          "kind": "user_input",
          "schema": { "required": ["name", "description", "workflow"] },
        },
        {
          "id": "harvest_context",
          "kind": "tool_call",
          "depends_on": ["collect"],
          "tool": "sessions_history",
          "when": "input._meta.sessionKey",
          "args": { "sessionKey": "{{input._meta.sessionKey}}", "limit": 12 },
        },
        {
          "id": "prepare",
          "kind": "tool_call",
          "depends_on": ["collect", "harvest_context"],
          "tool": "meta_skill_creator_prepare",
          "args":
            {
              "name": "{{collect.name}}",
              "description": "{{collect.description}}",
              "workflow": "{{collect.workflow}}",
              "content": "{{collect.content}}",
              "trigger": "{{collect.trigger}}",
              "audience": "{{collect.audience}}",
              "required_tools": "{{collect.required_tools}}",
              "support_files": "{{collect.support_files}}",
              "prior_context": "{{collect.prior_context}}",
              "harvested_context": "{{harvest_context.result.text}}",
              "risk_profile": "{{collect.risk_profile}}",
              "representative_invocation": "{{collect.representative_invocation}}",
              "require_runtime_e2e": "{{collect.require_runtime_e2e}}",
            },
        },
        {
          "id": "proposal",
          "kind": "tool_call",
          "depends_on": ["prepare"],
          "tool": "skill_workshop",
          "when": { "path": "prepare.result.details.gatesOk", "equals": true },
          "args":
            {
              "action": "{{prepare.result.details.workshopAction}}",
              "proposal_id": "{{prepare.result.details.workshopProposalId}}",
              "name": "{{prepare.result.details.name}}",
              "skill_name": "{{prepare.result.details.workshopSkillName}}",
              "description": "{{prepare.result.details.description}}",
              "proposal_content": "{{prepare.result.details.proposalContent}}",
              "support_files": "{{prepare.result.details.supportFiles}}",
              "goal": "{{prepare.result.details.goal}}",
              "evidence": "{{prepare.result.details.evidence}}",
            },
        },
      ],
  }
final_text_mode: step:proposal
---

# Meta Skill Creator

Create pending Skill Workshop proposals for reusable workflows from provided
workflow details or proposal content. Do not write active `SKILL.md` files
directly.
