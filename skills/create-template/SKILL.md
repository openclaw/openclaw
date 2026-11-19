---
name: create-template
description: Turn this agent into a shareable Template for a person to review. Tell the person you are drafting the Template as you load this skill.
user-invocable: true
---

# Create a Template

## While the person waits

[PR #202077](https://github.com/openclaw/openclaw/pull/202077) records the silent creation run that prompted the separate progress messages and single proposal write.

Stay with this agent in this conversation. A request to create a Template means prepare a private copy for review, not publish it.

1. **Start in chat.** Say “I'm drafting the Template now. I'll check what goes with it.” Then run one inventory command using this skill's absolute directory:

   `node <absolute-skill-directory>/scripts/inventory.mjs <absolute-current-agent-workspace> --agent <this agent's id> --json`

   Add `--draft <id>` only for the request-specific `workContext.detail.draftId` supplied by the Control UI. Otherwise the command starts a fresh draft. Keep its `draftId` and `draftPath`; never look for the latest draft or reuse another request's. It checks instructions, the avatar, skills, plugins and automations together. Don't run separate lookups for the sake of narration. If a lookup warned, say what you couldn't check rather than treating it as empty. If the command result is uncertain, inspect it before retrying.

2. **Send two short updates, at the decisions they describe.** Use `message(action="send", final=false)` in this chat, with no target. Send each as its own call in its own turn, before the file write. Don't send them as one paragraph, batch them with the write, or wait until the card opens. If messaging is unavailable, use ordinary progress text at the same steps.
   - When choosing the skills and plugins, name what this agent does and one useful inclusion or omission. For example: “I'm keeping Calendar Briefs and the Google Calendar plugin for the morning brief. Now I'm checking which routines belong.”
   - When you've chosen the automations, name the result and move on: “The weekday brief goes in. Your personal reminders stay here. I'm putting the Template together.” If nothing applies, say so briefly. If bundling a skill will take extra work, say which one you're preparing.

   These are examples, not a script. Use only facts from this agent. One or two short sentences per message; no role essay, file names, internal terms, personal details, or catalog of everything left out. The three messages should tell the person something new each time.

3. **Write once.** Use the agent's role and working instructions already in context. Only read a missing or truncated instruction if it defines the role. If there's no single coherent role, ask which one to share. Write the [proposal](#proposal-format) directly to `draftPath` with one file write. In a simple Template, a few concrete instructions about how to do the job are enough. Include what makes this agent useful, how it handles uncertainty, and when it hands work back. No word quota. Don't repeat the scope in the body or create another file just to restate the same instructions.

   Write for a new owner. Never copy raw conversations, memories, `USER.md`, private URLs, paths, accounts, credentials or personal facts. Include required skills, plugins and automations even when that takes longer. Use the inventory's exact ClawHub ref and version. For a required workspace skill, read its `SKILL.md`, then re-author it and its supporting text for a new owner. Don't invent dependencies, copy installed plugin trees, or carry a routine just because it's available. Choose routines only from the active automations in this inventory. Leave paused routines on the source agent; don't reconstruct them from memory. Rewrite included routines without the original owner's details.

4. **Open private review.** After the write succeeds, call `screen(action="template_review", draftId="<this request's draftId>")` on its own. The review builds and checks the exact archive; no second validation or generic docs lookup is needed. End with the card alone, not a recap or a claim that it rendered. Only the person can publish. If review can't open in the active administrator Control UI, keep the draft and explain the blocker. For revisions, update this draft and open a fresh review; don't upload, print internal paths or IDs, or invent a review link.

## Proposal format

Write one JSON object to `draftPath`:

```json
{
  "name": "research-brief",
  "description": "Turn a question and sources into a cited brief.",
  "version": "0.1.0",
  "avatar": "avatars/agent.png",
  "scope": {
    "input": "A research question and sources.",
    "job": "Compare the evidence for each answer.",
    "output": "A short brief with links and open questions.",
    "authority": "Read the supplied sources. Ask before contacting anyone."
  },
  "manifest": "---\nschemaVersion: 1\nagent:\n  id: research-brief\n---\nStart with primary sources. Link each claim to its evidence. When sources disagree, show where they differ and say what would resolve it. Lead with the answer and put uncertain findings last.\n",
  "files": []
}
```

- `name` is a lowercase unscoped package slug and must equal `agent.id`; `version` is exact semver, `0.1.0` for a first draft. Do not use the current agent's personal name unless it describes the role.
- `avatar` is the inventory's `avatar` value, copied unchanged, so the Template keeps this agent's picture; omit the field when the inventory has none. Review adds the image file and its manifest entries, so do not declare the avatar in the manifest yourself.
- `scope` has all four fields, each one or two sentences. Review appends them to `CLAW.md`.
- `manifest` is the complete `CLAW.md` text: YAML frontmatter, then a Markdown body that becomes the new agent's `SOUL.md`. Keep `schemaVersion: 1`. `categories` is optional: one to three lowercase slugs such as `engineering`, `operations`, `research`, `productivity`, or `personal`.
- Set `agent.id` to the slug. The card derives a display name from it unless you provide `agent.name`, and uses the top-level `description`. Leave out `tools`, `sandbox`, and `model` unless the person asked for them; a tool profile is rejected without an explicit allowlist of concrete tool names, and the new agent otherwise inherits its host's defaults.
- Use `files: []` unless the role needs another file. Each workspace file is newly authored text in `files`, mapped in the frontmatter. Use `workspace.bootstrapFiles` for startup files such as `AGENTS.md` and `workspace.files` (`source`, `path`) for others. The body already supplies `SOUL.md`; do not map `SOUL.md` separately.
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
