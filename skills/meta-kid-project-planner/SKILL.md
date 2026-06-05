---
name: meta-kid-project-planner
description: "Use when a child or guardian needs a safe, age-appropriate school, science, or hands-on project plan."
kind: meta
triggers: ["school project", "science fair", "孩子做项目", "我要做火山"]
risk_metadata:
  {
    "level": "medium",
    "notes":
      [
        "planning output only",
        "ported from OpenSquilla bundled meta-kid-project-planner",
        "does not use a Python sidecar",
        "this OpenClaw port avoids unavailable child skills and external tools",
      ],
  }
composition:
  {
    "steps":
      [
        {
          "id": "collect",
          "kind": "user_input",
          "schema":
            {
              "type": "object",
              "required": ["topic"],
              "properties":
                {
                  "topic": { "type": "string" },
                  "child_age": { "type": "string" },
                  "deadline": { "type": "string" },
                  "materials": { "type": "string" },
                  "parent_supervision": { "type": "string" },
                  "budget": { "type": "string" },
                  "language": { "type": "string" },
                },
              "additionalProperties": true,
            },
        },
        {
          "id": "feasibility",
          "kind": "llm_classify",
          "depends_on": ["collect"],
          "choices":
            ["STRAIGHTFORWARD", "NEEDS_ADULT_HELP", "SAFETY_REVIEW_REQUIRED", "INAPPROPRIATE"],
          "prompt": "Classify kid-project feasibility for a child or guardian request.\n\nTopic: {{collect.topic}}\nChild age or age band: {{collect.child_age}}\nDeadline: {{collect.deadline}}\nMaterials: {{collect.materials}}\nParent supervision: {{collect.parent_supervision}}\nBudget: {{collect.budget}}\nLanguage preference: {{collect.language}}\n\nDecision rules:\n- INAPPROPRIATE: weapons, fireworks, drugs, harmful chemistry, self-harm-adjacent themes, dangerous electricity, or other clearly unsafe projects for minors.\n- SAFETY_REVIEW_REQUIRED: heat, cutting tools, glass, soldering, reactive chemistry, rockets, water hazards, or anything that requires hands-on adult supervision.\n- NEEDS_ADULT_HELP: age-appropriate, but a meaningful step needs a guardian's hands, setup, cleanup, or judgment.\n- STRAIGHTFORWARD: the child can do most work with the declared supervision level.\n\nReturn exactly one choice.",
        },
        {
          "id": "project_pack_audit",
          "kind": "llm_chat",
          "depends_on": ["feasibility"],
          "prompt": "Rewrite the draft into the final user-facing project pack for the child and guardian.\n\nSource facts:\nTopic: {{collect.topic}}\nChild age or age band: {{collect.child_age}}\nDeadline: {{collect.deadline}}\nMaterials: {{collect.materials}}\nParent supervision: {{collect.parent_supervision}}\nBudget: {{collect.budget}}\nLanguage preference: {{collect.language}}\nFeasibility: {{feasibility.choice}}\n\nThis is an OpenClaw port of OpenSquilla's bundled meta-kid-project-planner. Preserve the same user experience goals: assess feasibility for the child's age band, build an age-appropriate plan, list materials and substitutes, surface concrete safety considerations, and include parent-facing learning objectives.\n\nSafety rules:\n- If feasibility is INAPPROPRIATE, do not give build instructions. Gently explain why this version is not a good kid project and offer three safer alternatives with similar curiosity or making goals.\n- If feasibility is SAFETY_REVIEW_REQUIRED or NEEDS_ADULT_HELP, clearly mark which steps require an adult.\n- Do not invent calendar dates, school rules, weather, allergies, measurements, or live facts.\n- Do not suggest tasting experiment materials unless the user explicitly requested an edible-food activity.\n- Keep output as chat markdown only. Do not create files, artifacts, paths, downloads, or sidecar state.\n\nFor Chinese requests, write Simplified Chinese. For English requests, write English. Use this structure for safe projects:\n# <project title>\n## Known facts and assumptions\n## Kid-sized plan\n## Materials and substitutes\n## Safety and failure modes\n## What the child will learn\n## Presentation script\n## Parent check-in plan\n## Missing information\n\nEnd with:\nPACK_DELIVERED: {{feasibility.choice}}",
        },
      ],
  }
final_text_mode: step:project_pack_audit
---

# meta-kid-project-planner

This is the OpenClaw port of OpenSquilla's bundled
`meta-kid-project-planner` meta-skill. It keeps the core experience: turn a
child's school, science, craft, or hobby project idea into a kid-sized plan plus
a guardian-facing supervision and learning pack.

The OpenSquilla source uses child skills such as search, memory, weather, deep
research, and presentation generation. This OpenClaw version is intentionally
self-contained because those child skills are not yet guaranteed in the
OpenClaw bundled catalog. It uses only native OpenClaw meta runtime steps and no
Python sidecar.
