# Adding skills and tools for a custom use case

This guide describes how to add **custom tools** and **skills** (with business rules) for a specific use case—for example, FirstLight: two tools (search + retrieval) plus a skill and rules for when and how to call them.

---

## Overview

| Piece              | Purpose                                                                                                                                                                 | Where it lives                                                                                                             |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| **Tools**          | Capabilities the agent can call (e.g. search a knowledge base, call an API).                                                                                            | OpenClaw **extension** or **plugin** (registers tools with the agent runtime).                                             |
| **Skill**          | One markdown file (SKILL.md) that names the tools, describes **when to use** them, **behavior** (how to combine, cite, handle no results), and **setup** (config, env). | **Workspace** `skills/<name>/SKILL.md`, or **config** `skills.load.extraDirs`, or a **plugin** that declares a skill path. |
| **Business rules** | When to call which tool, in what order, and guardrails.                                                                                                                 | In the **skill** (primary) and optionally in **AGENTS.md** / **SOUL.md** in the workspace.                                 |
| **Config**         | Allow the agent to use the tools; optionally enable the skill.                                                                                                          | `openclaw.yml`: `tools.alsoAllow` (or tool allowlist), `plugins.allow`, and optionally `skills.entries.<skillKey>`.        |

You do **not** need to change OpenClaw core. You need either:

- An **extension** (or plugin) that provides the tools—in the OpenClaw repo you run (upstream or your fork), or a plugin loaded from the workspace / `plugins.load.paths`—plus config and a skill file, or
- A **fork** of OpenClaw that adds the extension and (optionally) tool summaries/order in the system prompt for a polished experience.

---

## 1. Adding tools

Tools are registered by **extensions** (under `extensions/` in the OpenClaw repo) or **plugins** (loaded from workspace `.openclaw/extensions/`, `plugins.load.paths`, or bundled). Each tool has a **name**, **description**, **parameters** (schema), and an **execute** function.

- **If the tools already exist** (e.g. `gidr-mcp` with `search_troubleshooting` and `retrieval_firstlight_noc`): ensure that extension is enabled and allowlist the tool names in config (see below).
- **If you need new tools:** add an extension (or plugin) in the OpenClaw repo (or your fork), or in a plugin directory you load via `plugins.load.paths` / workspace extensions. The plugin SDK and existing extensions (e.g. `extensions/gidr-mcp`) are the reference for name, description, parameters (TypeBox schema), and `execute`.

**Config (allowlist):** so the agent can call your tools, add them to the tool allowlist, e.g. in `config/openclaw.yml`:

```yaml
# Example: allow Firstlight tools (adjust agent key if you use a named agent)
agents:
  defaults:
    tools:
      alsoAllow: ["search_troubleshooting", "retrieval_firstlight_noc"]
```

Or at the top level if your config uses a global tool allowlist. The exact key depends on your OpenClaw config schema (`tools.alsoAllow`, `agents.defaults.tools.alsoAllow`, or allowlist by plugin id).

---

## 2. Adding a skill (SKILL.md)

A **skill** is a markdown file (with optional frontmatter) that tells the agent about a set of tools and how to use them. It is the main place for **business rules**: when to use which tool, in what order, and how to behave.

**Where to put the skill:**

- **Workspace:** `workspace/skills/<skill-name>/SKILL.md` (e.g. `skills/firstlight/SKILL.md`). The agent’s workspace is the one set in config (e.g. `agents.defaults.workspace`).
- **Config:** `skills.load.extraDirs`: list paths to directories that contain skill subdirs (e.g. `["/path/to/my-skills"]` where `my-skills/firstlight/SKILL.md` exists).
- **Plugin:** a plugin can declare `skills: ["skills/firstlight"]` in its manifest (path relative to the plugin root); OpenClaw will load that skill when the plugin is enabled.

**Structure of SKILL.md:**

```markdown
---
name: firstlight
description: Firstlight NOC and troubleshooting. Use search_troubleshooting and retrieval_firstlight_noc for network/equipment issues, runbooks, or when the user asks for Firstlight or uses /firstlight.
metadata:
  openclaw:
    emoji: "🔍"
    requires: { env: ["GIDR_MCP_URL"] }
---

# Firstlight NOC and troubleshooting

When the user has a troubleshooting question, needs NOC/runbook content, or explicitly invokes **/firstlight**, use the GIDR MCP tools.

## Tools

- **search_troubleshooting** — Search the Firstlight troubleshooting / NOC knowledge base. Use for symptoms, equipment, vendor, outage queries. Pass `query` (required), optional `limit`, `search_mode` (text or hybrid), filters. Prefer `search_mode: "text"`. Return results with citations.
- **retrieval_firstlight_noc** — Retrieve NOC/runbook content. Use for procedures or when the user asks for Firstlight NOC. Pass `query` and optional `limit`, `search_mode`.

## When to use

- User asks about network issues, slow speeds, outages, equipment, or troubleshooting steps.
- User asks for NOC procedures, runbooks, or Firstlight-specific content.
- User sends **/firstlight** or says they want Firstlight / NOC help.

## Behavior

- Extract a clear search query from the user; ask a short clarifying question if the intent is ambiguous.
- Call **search_troubleshooting** and/or **retrieval_firstlight_noc** as needed; combine results when both apply.
- If a tool returns no results, say so and suggest refining the query or scope.
- In replies, cite sources when the tool returns them.

## Setup

- Enable the **gidr-mcp** extension and set `GIDR_MCP_URL` and `GIDR_API_KEY` (or `GIDR_API_KEY_FILE`).
- In config, allowlist the tools, e.g. `tools.alsoAllow: ["search_troubleshooting", "retrieval_firstlight_noc"]`.
```

Frontmatter:

- **name** — Skill name (used for eligibility and display).
- **description** — Short summary (shown in skill lists; include when to use and tool names).
- **metadata.openclaw** — Optional: `emoji`, `requires.env` (env vars that must be set for the skill to be eligible), `skillKey` (config key under `skills.entries`).

The body is the **business rules**: which tools exist, when to use them, how to combine and cite, and setup. The agent sees this in context, so be explicit about when to call which tool and how to handle errors or empty results.

---

## 3. Business rules: where to put them

- **In the skill (SKILL.md):** Primary place. Use sections like “When to use”, “Behavior”, “Tools”. Describe order (e.g. “prefer search_troubleshooting first, then retrieval_firstlight_noc if the user wants procedures”).
- **In AGENTS.md / SOUL.md:** Optional. Add a short line such as: “For Firstlight NOC and troubleshooting, follow the **firstlight** skill; use the two tools only when the user’s intent matches that skill.”
- **Tool summaries and order in the system prompt:** OpenClaw’s system prompt can include short tool descriptions and a suggested tool order. That lives in the OpenClaw repo (`src/agents/system-prompt.ts`). To add or change them you either contribute to upstream or maintain a fork. For many use cases, the **skill file alone** is enough; the model follows the skill’s “When to use” and “Behavior” without needing system-prompt changes.

---

## 4. FirstLight example (two tools + skill + rules)

**Tools (from gidr-mcp extension):**

1. **search_troubleshooting** — Search troubleshooting / NOC knowledge base (symptoms, equipment, outages).
2. **retrieval_firstlight_noc** — Retrieve NOC/runbook content.

**Skill:** `skills/firstlight/SKILL.md` (in workspace or in an extraDir). Content as in the template above: tools, when to use, behavior, setup.

**Config:**

- Enable the extension (e.g. `plugins.allow` includes the extension id if it’s a plugin, or the extension is bundled).
- Set env: `GIDR_MCP_URL`, `GIDR_API_KEY` (or `GIDR_API_KEY_FILE`).
- Allowlist tools: `tools.alsoAllow: ["search_troubleshooting", "retrieval_firstlight_noc"]` (or equivalent in your config).

**Rules (in the skill):**

- Use **search_troubleshooting** for symptoms, equipment, outages; use **retrieval_firstlight_noc** for procedures/runbooks; use both when the user has a troubleshooting question that may need both search and procedure content.
- Prefer `search_mode: "text"`; cite sources; on no results, suggest refining the query.

---

## 5. Checklist for a new use case

1. **Tools** — Implement in an extension or plugin (OpenClaw repo or fork, or loadable plugin). Register name, description, parameters, execute.
2. **Config** — Enable the extension/plugin; set required env vars; allowlist tool names (`tools.alsoAllow` or equivalent).
3. **Skill** — Add `skills/<name>/SKILL.md` (workspace, extraDirs, or plugin). Include: tools, when to use, behavior, setup.
4. **Business rules** — Write “When to use” and “Behavior” in the skill; optionally reinforce in AGENTS.md/SOUL.md.
5. **(Optional)** System-prompt tool summaries/order — Only if you want them; requires editing OpenClaw (fork or upstream).

---

## References

- [Skills config](https://docs.openclaw.ai/tools/skills-config) — `skills.load.extraDirs`, `skills.entries`, allowlists.
- [OpenClaw plugins](https://docs.openclaw.ai/plugin) — How to add a plugin that registers tools (and optionally a skill path).
- FirstLight skill in repo: `skills/firstlight/SKILL.md`.
- GIDR MCP extension: `extensions/gidr-mcp/` (tools + optional env).
