---
title: "Docs tools, skills, and plugins navigation refactor"
summary: "Specification for splitting the tools overview, automation docs, and agent coordination docs into clearer navigation surfaces"
read_when:
  - You are changing the Tools, Skills & Plugins docs tab
  - You are moving automation or agent coordination pages in docs navigation
  - You need the intended information architecture for tools, skills, plugins, agents, and automation docs
---

## Status

Completed implementation specification.

## Goal

Make the docs navigation match the conceptual ownership of the pages that used
to be grouped under the broad Tools & Plugins tab:

- Tools, skills, and plugins stay together as the capability-extension surface.
- Automation and task-related pages move to a dedicated Automation tab.
- Agent coordination pages move under Agents.
- `docs/tools/index.md` becomes a focused overview and routing page instead of
  carrying the detailed tool policy reference.

## In scope

- Rename the Tools & Plugins tab to Tools, Skills & Plugins.
- Move automation, cron, tasks, Task Flow, standing orders, hooks, heartbeat,
  and commitments into an Automation tab.
- Move `tools/agent-send`, `tools/steer`, `tools/subagents`,
  `tools/acp-agents`, `tools/acp-agents-setup`, and
  `tools/multi-agent-sandbox-tools` under Agents.
- Rewrite the tools overview as a concise hub for tools, skills, plugins, tool
  policy, automation, and agent coordination entry points.
- Rename visible Automation & Tasks labels to Automation where they refer to
  the new top-level docs section.
- Add a changelog entry for the docs navigation change.

## Out of scope

- No runtime behavior changes.
- No tool policy schema or provider configuration changes.
- No renaming of file paths such as `docs/tools/*` or `docs/automation/*`.
- No migration of automation implementation docs into gateway reference pages.

## Source references

- [Tools overview](/tools)
- `docs/docs.json`
- [Automation overview](/automation)
- [Tools and custom providers](/gateway/config-tools)
- [Sub-agents](/tools/subagents)
- [ACP agents](/tools/acp-agents)
- `docs/AGENTS.md`
- `CHANGELOG.md`

## Navigation ownership

| Surface                 | Owns                                                                                                      | Does not own                                                                              |
| ----------------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Tools, Skills & Plugins | Tool overview, tool categories, provider-backed tools, plugin management, plugin SDK, skill configuration | Background work scheduling, task ledgers, agent coordination                              |
| Automation              | Cron, tasks, Task Flow, heartbeat, commitments, standing orders, hooks                                    | Generic plugin installation and low-level tool policy                                     |
| Agents                  | Agent model, sessions, memory, multi-agent coordination, ACP agents, sub-agents, steering                 | Scheduler/task overview and plugin SDK reference                                          |
| Gateway                 | Gateway configuration, security, sandbox/tool policy interaction, runtime operations                      | User-facing automation wayfinding when the page is about choosing an automation mechanism |

## Desired docs behavior

`docs/tools/index.md` should answer:

- What are tools, skills, and plugins?
- What built-in tool categories exist?
- Where does the reader configure allowlists, profiles, exec approvals, and
  provider-backed tool policy?
- Where should the reader go for automation or agent coordination?

The page should not duplicate the full `tools.*` config reference because
`docs/gateway/config-tools.md` is the canonical policy reference.

`docs/automation/index.md` should be the canonical entry point for scheduled and
background work. Link labels should say Automation when they point to that
top-level section.

`docs/docs.json` should present automation as a peer section, not a subsection
of tools. Agent coordination should appear under Agents so readers looking for
sub-agents or ACP agents discover those pages beside the agent model and session
docs.

## Acceptance criteria

- [x] The navigation has a Tools, Skills & Plugins tab.
- [x] Automation is no longer nested under the tools tab.
- [x] Agent coordination is no longer nested under the tools tab.
- [x] The Automation tab includes the automation overview, cron jobs, tasks,
      Task Flow, heartbeat, commitments, standing orders, and hooks.
- [x] `docs/tools/index.md` is a concise hub and links to the canonical policy,
      automation, and agent coordination pages.
- [x] User-facing labels that describe the automation hub use Automation rather
      than Automation & Tasks.
- [x] The docs changelog records the navigation refactor.
- [x] Docs links remain root-relative and suffix-free.

## Validation results

- `pnpm docs:list`: passed.
- `pnpm docs:check-mdx`: passed, 635 files.
- `pnpm docs:check-links`: passed, `checked_internal_links=4304`,
  `broken_links=0`.
- `pnpm docs:check-i18n-glossary`: passed.
- `pnpm lint:docs`: passed, 0 errors.
- `git diff --check`: passed.
- `docs/docs.json` parse check: passed.
