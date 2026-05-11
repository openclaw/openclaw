---
doc-schema-version: 1
title: "Docs capabilities navigation refactor"
summary: "Specification for renaming the broad tools docs tab to Capabilities while keeping automation and agent coordination as sections"
read_when:
  - You are changing the Capabilities docs tab
  - You are moving automation or agent coordination pages in docs navigation
  - You need the intended information architecture for tools, skills, plugins, agents, and automation docs
---

## Status

Completed implementation specification.

## Goal

Make the docs navigation match the broad reader question behind the old Tools &
Plugins tab without splitting related capability surfaces across separate tabs:

- Rename the broad tools tab to Capabilities.
- Keep tools, skills, plugins, automation, and agent coordination together as
  sections under Capabilities.
- Rename the old Automation and tasks section to Automation.
- Keep `docs/tools/index.md` focused on tools, skills, and plugins instead of
  carrying the detailed tool policy reference.

## In scope

- Rename the top-level Tools & Plugins docs tab to Capabilities.
- Keep the tools overview in a `Tools, skills, and plugins` group.
- Keep plugin management, plugin SDK, skill configuration, automation, tool
  reference, and agent coordination pages as groups under Capabilities.
- Rewrite the tools overview as a concise hub for tools, skills, plugins, tool
  policy, automation, and agent coordination entry points.
- Rename visible Automation & Tasks labels to Automation.
- Add a changelog entry for the docs navigation change.

## Out of scope

- No runtime behavior changes.
- No tool policy schema or provider configuration changes.
- No renaming of file paths such as `docs/tools/*` or `docs/automation/*`.
- No migration of automation implementation docs into gateway reference pages.
- No dedicated top-level Automation tab in this iteration.
- No relocation of agent coordination pages into the Agents tab.

## Source references

- [Tools, skills, and plugins overview](/tools)
- `docs/docs.json`
- [Automation overview](/automation)
- [Tools and custom providers](/gateway/config-tools)
- [Sub-agents](/tools/subagents)
- [ACP agents](/tools/acp-agents)
- `docs/AGENTS.md`
- `CHANGELOG.md`

## Navigation ownership

| Surface      | Owns                                                                                                                                | Does not own                                                                                 |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Capabilities | Tool overview, tool categories, provider-backed tools, plugin management, plugin SDK, skill configuration, automation, coordination | Agent model fundamentals, session lifecycle, memory model, gateway operations                |
| Agents       | Agent model, sessions, memory, high-level multi-agent concepts                                                                      | Tool docs, automation mechanisms, plugin SDK reference, agent coordination tool reference    |
| Gateway      | Gateway configuration, security, sandbox/tool policy interaction, runtime operations                                                | User-facing capability catalog when the page is about choosing tools, automation, or plugins |

## Desired docs behavior

`docs/docs.json` should present the old Tools & Plugins area as a Capabilities
tab with these sections:

- Tools, skills, and plugins
- Plugins
- Skills
- Automation
- Tools
- Agent coordination

Automation should remain a Capabilities section because cron jobs, tasks, Task
Flow, standing orders, and hooks describe what the user can make OpenClaw do.
It should not become a separate top-level tab for this refactor.

Agent coordination should remain a Capabilities section because `agent-send`,
steering, sub-agents, ACP agents, and sandbox tools are operational capability
surfaces. The Agents tab should stay focused on the agent model, sessions,
memory, and higher-level multi-agent concepts.

`docs/tools/index.md` should answer:

- What are tools, skills, and plugins?
- What built-in tool categories exist?
- Where does the reader configure allowlists, profiles, exec approvals, and
  provider-backed tool policy?
- Where should the reader go for automation or agent coordination?

The page should not duplicate the full `tools.*` config reference because
`docs/gateway/config-tools.md` is the canonical policy reference.

## Acceptance criteria

- [x] The navigation has a Capabilities tab.
- [x] Capabilities contains a Tools, skills, and plugins overview group.
- [x] Capabilities contains Plugins, Skills, Automation, Tools, and Agent
      coordination sections.
- [x] No dedicated top-level Automation tab is introduced by this refactor.
- [x] Agent coordination is not nested under the Agents tab.
- [x] `docs/tools/index.md` is a concise hub and links to the canonical policy,
      automation, and agent coordination pages.
- [x] User-facing labels that describe the automation hub use Automation rather
      than Automation & Tasks.
- [x] The docs changelog records the navigation refactor.
- [x] Docs links remain root-relative and suffix-free.

## Validation results

- `node scripts/docs-list.js`: passed.
- `node scripts/format-docs.mjs --check`: passed, 623 files.
- `node scripts/check-docs-mdx.mjs docs README.md`: passed, 639 files.
- `node scripts/docs-link-audit.mjs`: passed, `checked_internal_links=4313`,
  `broken_links=0`.
- `node scripts/check-docs-i18n-glossary.mjs`: passed.
- `pnpm lint:docs`: not rerun after rebase because local pnpm 11 bootstrap is
  blocked by minimum-release-age policy for `pnpm@11.0.8`.
- `git diff --check`: passed.
- `docs/docs.json` parse check: passed.
