---
name: create-template
description: Turn this agent into a shareable Template for a person to review. Tell the person you are drafting the Template as you load this skill.
user-invocable: true
---

# Create a Template

Use this skill when the person asks to create a Template from this agent, including ordinary chat requests such as “create a new template from this agent.” No sidebar action or special command is required. Stay in this conversation and use this agent's current workspace and durable instructions as source material. Prepare only a private proposal; the existing Control UI owns exact-archive review, package assembly, and explicit human publication. A request to create a Template is not permission to publish it.

The person is waiting and watching, so this is a short, spoken procedure: four quick turns after loading this skill, about a minute in total, with one tool call per turn:

| Turn | What the person sees                            | Tool call                       |
| ---- | ----------------------------------------------- | ------------------------------- |
| 1    | “I’m drafting the Template now.”                | The inventory command           |
| 2    | What you found and what the Template will carry | A progress message              |
| 3    | The proposal being written                      | One file write                  |
| 4    | The review card                                 | `screen` with `template_review` |

Use everyday words about what you looked at and decided; leave out tool names, commands, paths, and IDs. This file is the complete procedure and format, and these are first-draft decisions: the person reviews the result and can ask for changes, so decide quickly instead of weighing alternatives. Do not read OpenClaw documentation, other Templates, or other skills, and do not run validation, verification, or other inventory commands: each one costs the person a silent wait, and the review step already builds and checks the exact archive.

1. **Acknowledge, then take inventory.** Begin your reply with a short acknowledgment as ordinary text, such as “I’m drafting the Template now.” In the same turn, run exactly one command, using the absolute directory of this `SKILL.md`:

   `node <absolute-skill-directory>/scripts/inventory.mjs <absolute-current-agent-workspace> --agent <this agent's id> --json`

   It starts this request's private draft and returns its `draftId` and `draftPath` together with the agent's avatar, instruction files, and the skills, plugins, and automations a Template could carry. Skills and plugins that cannot travel are only counted, so do not look for them. If this turn has a request-specific `workContext.detail.draftId` from the optional Control UI entry, add `--draft <that id>` so the existing draft is reused. Independent requests each get a new draft; never search for a latest draft, use a shared pointer, select a different agent, or start another conversation. If the output has `warnings`, that part of the inventory could not be checked: carry on without it and say so in your progress message. If the command has an uncertain result, inspect its output before running it again. Your startup instructions are already in your context, so do not re-read them; read an instruction file from the inventory only if its text is missing or truncated in your context and it defines the role. Complete when you have the draft path and the inventory.

2. **Tell the person what is going in.** As soon as the inventory returns, decide what the Template carries and send that to the person as a progress message: call the `message` tool with `action: "send"`, `final: false`, no target, and one or two sentences such as “I went through my instructions, skills, routines, and plugins. The Template will carry the weekly-report role with its two report skills and the Monday routine; your personal preferences and memory stay out.” Name the role and the instructions, skills, routines, and plugins that matter for it, and anything notable you are leaving out as personal. Make this the only call in this turn: calls made in one turn are sent together when the turn ends, so a message placed beside the file write would reach the person only after the writing had finished. If no `message` tool is available, skip this turn and open the next one with the same sentences as reply text.

3. **Write the proposal.** Write the finished proposal to `draftPath` with a single file write. You have already decided what goes in, so do not outline or compose the text in private reasoning first; that doubles the wait. Write it once, directly into the file, following [Proposal format](#proposal-format) and these rules:
   - **One coherent role.** Identify the reusable role, its input, job, output, and authority from this conversation and your durable instructions. If the agent's responsibilities do not form one coherent Template, ask which responsibility to share instead of writing.
   - **Rewrite for a new owner.** Author fresh, portable text. Preserve the behavior that defines the role and leave out the current owner's context. Never include raw conversations, memories, `USER.md`, credentials, secret values, private URLs, local paths, account names, or personal facts, and never copy the source workspace tree.
   - **Keep it proportionate.** A Template is a starting point, and the person is waiting while you write. State the role in the `CLAW.md` body in a few short sections, and add `AGENTS.md` only for working agreements the role depends on; together they should run to roughly 600 to 900 words. Port what defines the role, not every preference.
   - **Declare only what the role requires.** Availability alone is not a requirement, and when in doubt, leave it out: instructions alone make a complete Template. Use a `ref` and `version` exactly as the inventory reports them for a ClawHub skill or plugin. Bundle a workspace skill with a `path` entry only when the role cannot do its job without it; to bundle one, first read its `SKILL.md` and re-author it for a new owner, with its root `SKILL.md` and supporting text files, and never write a skill from memory. Each bundled skill adds reading and writing time, so say so in your progress message. Never invent a ClawHub reference, version, or verification, and never copy an installed plugin tree, its dependencies, or private source material. Include an automation only when the role is built around that routine, rewritten for a new owner.

   Complete when the JSON at `draftPath` is valid, its four scope fields describe an agent a new person can use, and every file and declaration has a reason tied to the role.

4. **Hand off for review.** Wait for the write to return, then call `screen(action="template_review", draftId="<this request’s draftId>")` as its own turn, without text. Calls made in the same turn can run at the same time, so a review requested beside the write could open before the file exists. Do not pass another session or agent: review is bound to this conversation and this agent. The native read-only review appears inline and shows the exact built archive; the person can inspect its files and dependencies and explicitly publish there. End the turn with the native card alone: its description and contents are the explanation. Do not add a heading, “Template ready for review,” a repeated summary, or a follow-up confirmation. Do not print internal paths or IDs, invent a review link, upload, invoke publication, or claim that returning the review descriptor proves the review rendered. To change the name, description, files, or dependencies later, revise this request’s proposal and call screen again for a fresh review; the preview itself does not edit or remove items. If screen or review is unavailable (for example outside an active administrator Control UI or with Templates Lab disabled), keep the private draft and report that precise blocker without publishing or redirecting to a different conversation. Complete when review is available to the person, or the review-delivery blocker is clearly reported.

## Proposal format

Write one JSON object to `draftPath`:

```json
{
  "name": "portable-agent-slug",
  "description": "What another person can do with this agent.",
  "version": "0.1.0",
  "avatar": "avatars/agent.png",
  "scope": {
    "input": "What a new user provides.",
    "job": "What the agent does.",
    "output": "What the user receives.",
    "authority": "What the agent may do without further approval."
  },
  "manifest": "---\nschemaVersion: 1\ncategories:\n  - engineering\nagent:\n  id: portable-agent-slug\n  name: Portable Agent\n  description: What another person can do with this agent.\nworkspace:\n  bootstrapFiles:\n    AGENTS.md:\n      source: workspace/AGENTS.md\n---\n\n# Portable Agent\n\nPortable instructions for a new owner.\n",
  "files": [{ "path": "workspace/AGENTS.md", "content": "# Working agreements\n\n..." }]
}
```

- `name` is a lowercase unscoped package slug and must equal `agent.id`; `version` is exact semver, `0.1.0` for a first draft. Do not use the current agent's personal name unless it describes the role.
- `avatar` is the inventory's `avatar` value, copied unchanged, so the Template keeps this agent's picture; omit the field when the inventory has none. Review adds the image file and its manifest entries, so do not declare the avatar in the manifest yourself.
- `scope` has all four fields, each one or two sentences. Review appends them to `CLAW.md`.
- `manifest` is the complete `CLAW.md` text: YAML frontmatter, then a Markdown body that becomes the new agent's `SOUL.md`. Keep `schemaVersion: 1`. `categories` is optional: one to three lowercase slugs such as `engineering`, `operations`, `research`, `productivity`, or `personal`.
- Under `agent`, set `id`, `name`, and `description`. Leave out `tools`, `sandbox`, and `model` unless the person asked for them; a tool profile is rejected without an explicit allowlist of concrete tool names, and the new agent otherwise inherits its host's defaults.
- Each workspace file is newly authored text in `files`, mapped in the frontmatter. Use `workspace.bootstrapFiles` for startup files such as `AGENTS.md` and `workspace.files` (`source`, `path`) for others. The body already supplies `SOUL.md`; do not map `SOUL.md` separately.
- Add dependency sections only when needed:

  ```yaml
  skills:
    - path: skills/portable-checklist
    - ref: "@publisher/skill-name"
      version: 1.2.3
  plugins:
    - ref: "@publisher/plugin-name"
      version: 2.0.0
  automations:
    - id: daily-summary
      name: Daily summary
      schedule: { cron: "0 9 * * *", timezone: UTC }
      session: main
      message: Summarize what changed since yesterday.
  ```

  A bundled skill at `skills/portable-checklist` needs `skills/portable-checklist/SKILL.md`, with a `name` and `description`, in `files`. MCP requirements go in `mcpServers` with environment values left as `${NAME}` references. Review rejects unsafe paths and credential-like content.
