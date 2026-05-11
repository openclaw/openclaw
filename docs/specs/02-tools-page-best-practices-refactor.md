---
title: "Tools page best-practices refactor"
summary: "Specification for rewriting the tools overview so it follows OpenClaw docs best practices without duplicating reference pages"
read_when:
  - You are rewriting the tools overview page
  - You are deciding what belongs on the tools, skills, and plugins overview
  - You need the intended reader flow for the Capabilities tools page
---

## Status

Accepted, implemented, and coverage-audited.

## Goal

Refactor `docs/tools/index.md` into a stronger OpenClaw docs overview page:
fast for readers choosing a capability surface, precise about where tool policy
lives, and brief enough that it does not become a second configuration
reference.

The page should answer one first-screen question: "What should I use or
configure next?"

## Page type

Use the OpenClaw docs skill's **Overview** page type.

This page should route users to the right product surface and deeper guide. It
should not try to become a topic page, a config reference, or a complete tool
catalog.

## Audience

- Operators configuring which tools an agent can use.
- Agent builders deciding between a built-in tool, skill, or plugin.
- Plugin authors looking for the right extension entry point.
- Support/debugging readers who need to know why a tool is missing.

## Current problems

- The page starts with useful definitions, but the recommended path is mostly a
  table of links. It does not give one clear default path before alternatives.
- "Built-in tool categories" lists common tool ids, which is useful, but it
  risks drifting from `docs/gateway/config-tools.md` and individual tool pages.
- "Plugin-provided tools" mixes conceptual ownership with a grab bag of example
  tools. This is harder to scan than a reader-intent map.
- The page explains tool policy but does not include a compact troubleshooting
  path for the common observable failure: "the model cannot see or call a tool."
- The page has no explicit scope statement saying that exhaustive config,
  defaults, enum values, and policy behavior belong in linked reference pages.
- The first implementation compressed the category table too far and dropped
  reader-recognition cues from the previous page, including `code_execution`,
  `x_search`, file `edit`, `image`, and common plugin-provided tool examples.

## Proposed structure

### Opening

State what the reader can do on this page in two short paragraphs:

- Tools are callable actions.
- Skills teach workflows.
- Plugins add runtime capabilities.
- Use this page to choose the surface; use linked reference pages for exhaustive
  config and API details.

### Start here

Replace the current link table with a recommended-path table ordered by reader
intent:

| If you need to...                           | Use this first     | Then read                              |
| ------------------------------------------- | ------------------ | -------------------------------------- |
| Let an agent act with existing capabilities | Built-in tools     | Tool categories                        |
| Control what an agent can call              | Tool policy        | Tools and custom providers             |
| Teach an agent a workflow                   | Skills             | Skills and creating skills             |
| Add a new integration or runtime surface    | Plugins            | Plugin management and building plugins |
| Run work later or in the background         | Automation         | Automation overview                    |
| Coordinate multiple agents or harnesses     | Agent coordination | Sub-agents and ACP agents              |

The first row should be the default path for most users. Alternatives should be
short and link to canonical pages.

### Choose between tools, skills, and plugins

Keep the three-layer explanation, but make each block decision-oriented:

- Use a tool when the agent needs to perform an action.
- Use a skill when the agent needs instructions for when and how to work.
- Use a plugin when OpenClaw needs a new tool, provider, channel, skill bundle,
  hook, or runtime capability.

Avoid long implementation detail here. Link plugin implementation details to the
Plugin SDK pages.

### Tool categories

Keep a compact category table, but remove fragile details that belong to the
reference:

- Keep category names, reader outcome, and canonical links.
- Avoid exhaustive policy-group semantics.
- Include representative tool ids when they help search or recognition,
  especially ids that were already surfaced on the old overview.
- Link `tools/tool-search` from the Web or discovery category only if the page
  clearly distinguishes PI Tool Search from Codex-native tool search.

The table should not duplicate the full tool group list from
`docs/gateway/config-tools.md`.

### Configure access and approvals

Add a short routing section for policy and safety decisions:

- Tool profiles, allow/deny lists, provider restrictions:
  [Tools and custom providers](/gateway/config-tools)
- Host command approvals: [Exec approvals](/tools/exec-approvals)
- Elevated execution: [Elevated exec](/tools/elevated)
- Sandbox versus policy: [Sandbox vs tool policy vs elevated](/gateway/sandbox-vs-tool-policy-vs-elevated)
- Per-agent restrictions: [Per-agent sandbox and tool restrictions](/tools/multi-agent-sandbox-tools)

This section should state that policy is enforced before the model call and can
remove tools from the model's available schema list.

### Extend capabilities

Split extension paths by job:

- Install or manage plugins: [Plugins](/tools/plugin)
- Build plugins: [Build plugins](/plugins/building-plugins)
- Add or tune skills: [Skills](/tools/skills) and
  [Creating skills](/tools/creating-skills)
- Package reusable workflows: [Skill workshop](/plugins/skill-workshop) when
  appropriate

Keep a short list of common plugin-provided tools that already had first-class
docs links, such as Diffs, LLM Task, Lobster, Tokenjuice, Tool Search, and
Canvas. It can name `api.registerTool(...)` and `contracts.tools` as the
authoring entry points, but should not explain plugin descriptor caching or
manifest internals on the overview page. Link to SDK and manifest reference
pages instead.

### Troubleshoot missing tools

Add a short symptom-driven checklist:

1. Check the active tool profile and allow/deny policy.
2. Check provider-specific restrictions.
3. Check channel permissions and sandbox/elevated state.
4. Check whether the owning plugin is installed and enabled.
5. Check whether the model/provider supports the tool shape.

Each item should link to the canonical page that explains the check.

### Related

Keep the Related section short and cumulative:

- Automation
- Agents
- Tools and custom providers
- Plugins
- Plugin SDK
- Skills
- Tool Search

## Content rules

- Use sentence-case headings.
- Keep the first screen short enough to scan.
- Use descriptive link text.
- Keep details task-oriented and current-behavior focused.
- Do not duplicate exhaustive config tables, defaults, enum values, or SDK
  contracts from reference pages.
- Do not add new runtime claims without checking source or the canonical docs.
- Avoid local paths, personal examples, and internal-only terminology.
- Keep all internal links root-relative and suffix-free.

## Out of scope

- No nav restructuring.
- No runtime, config, SDK, or plugin behavior changes.
- No rewrite of `docs/gateway/config-tools.md`.
- No exhaustive tool catalog.
- No changes to localized docs under `docs/zh-CN/**`.

## Implementation plan after approval

1. Rewrite `docs/tools/index.md` using the proposed structure.
2. Preserve the existing title, summary, and read-when intent unless the review
   finds better routing language.
3. Keep existing canonical links and add only links needed by the new sections.
4. Update `docs/.i18n/glossary.zh-CN.json` only for new public titles or short
   labels required by the glossary checker.
5. Run docs validation:
   - `node scripts/docs-list.js`
   - `node scripts/format-docs.mjs --check`
   - `node scripts/check-docs-mdx.mjs docs README.md`
   - `node scripts/docs-link-audit.mjs`
   - `node scripts/check-docs-i18n-glossary.mjs`
   - `git diff --check`

`pnpm` wrappers should be used when local pnpm bootstrap is healthy. If the
current `pnpm@11.0.8` minimum-release-age bootstrap still blocks local pnpm,
use the direct Node scripts and report the blocker.

## Acceptance criteria

- The page reads as an overview and routing page, not a reference.
- The first screen makes the recommended path obvious.
- Tools, skills, and plugins are distinguished by user decision, not product
  taxonomy alone.
- Tool policy points to `docs/gateway/config-tools.md` as the canonical
  reference.
- Missing-tool troubleshooting starts from observable symptoms.
- The page links to automation and agent coordination without owning their
  detailed workflows.
- The page avoids duplicating exhaustive tool group or SDK reference tables.
- A coverage audit against the old page preserves previously mentioned
  first-class entities through either the overview itself or a canonical link.
- Docs validation passes, or any blocked local validation has a precise reason.

## Review questions

- Should the overview keep representative tool ids in the category table, or
  remove ids entirely and rely on destination pages?
- Should Tool Search appear in the main category table, Related, or both?
- Should the missing-tool checklist include provider capability support, or is
  that too detailed for this overview?
