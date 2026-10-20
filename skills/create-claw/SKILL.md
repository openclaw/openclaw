---
name: create-claw
description: Turn this agent into a shareable Claw for a person to review.
user-invocable: true
disable-model-invocation: true
---

# Create a Claw

The `/skill create-claw` message names a private draft JSON path and a review link. Work in this same conversation; prepare the draft for the person, then return the review link. The Control UI owns package assembly and publication.

1. **Capture the reusable agent.** Read the existing draft JSON. Use this conversation and the agent's durable instructions to identify its coherent reusable role, input, job, output, and authority. Preserve useful behavior and settings; leave out personal context. If the responsibilities do not form one coherent Claw, ask which responsibility to share before writing. Complete when the four scope fields describe an agent a new person can use.
2. **Inventory only relevant material.** Select portable workspace instructions and files that implement that role. Locate this `SKILL.md` and use its `scripts/cli.mjs` for inventory so the CLI matches the running OpenClaw installation; invoke it with an absolute path when outside the skill directory. Run `node scripts/cli.mjs skills list --agent <this agent's id> --json` and `node scripts/cli.mjs plugins list --enabled --json`. Compare the results with tools actually available in this session and capabilities used in the role. Inspect a candidate with `node scripts/cli.mjs plugins inspect <id> --json` for its source and exact version. Declare a skill or plugin only when you can ground it in a current ClawHub package reference and exact version; plugin availability alone is not a requirement. Put package references in `packages`, MCP requirements in `mcpServers`, and useful schedules in `cronJobs`. Their declarations are dependencies, not files copied into the archive. Complete when every included file and declaration has a reason tied to the reusable role.
3. **Author the proposal.** Follow [the draft format](references/draft-format.md). Rewrite instructions for a new owner. Include input, job, output, and authority in the draft `scope`, and describe the portable behavior in `CLAW.md`. Place only newly authored portable text in `files`, mapping included workspace files by `source` in the manifest. Exclude raw conversations, memories, `USER.md`, credentials, secret values, private URLs, local paths, and personal facts. Never copy the source workspace tree. Complete when the JSON at the supplied path is valid and contains no private source material.
4. **Hand off for review.** Tell the person what the Claw does, which optional files/dependencies you included, and any capability you could not port. Return the supplied review link. Do not upload or publish; the person will inspect the exact built archive, remove optional items, and explicitly publish in the Control UI. Complete when the person can open the review.
