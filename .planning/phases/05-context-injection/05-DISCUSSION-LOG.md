# Phase 5: Context Injection - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-03-27
**Phase:** 05-context-injection
**Areas discussed:** CWD-based PROJECT.md pickup, Bootstrap hook integration, Capability tags in IDENTITY.md, Context content and format

---

## CWD-Based PROJECT.md Pickup

### Q1: How should PROJECT.md be detected?

| Option                         | Description                                                                                                           | Selected |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------- | -------- |
| Walk up from cwd (Recommended) | Search from agent's cwd upward through parent dirs until PROJECT.md is found or ~/.openclaw/projects/ root is reached | ✓        |
| Exact cwd only                 | Only detect PROJECT.md if it exists in the exact current working directory                                            |          |
| Config-specified path          | PROJECT.md path is set in agent config or project config                                                              |          |

**User's choice:** Walk up from cwd
**Notes:** Matches how AGENTS.md lookup works

### Q2: What happens when PROJECT.md is found?

| Option                                 | Description                                                                    | Selected |
| -------------------------------------- | ------------------------------------------------------------------------------ | -------- |
| Inject as bootstrap file (Recommended) | Add PROJECT.md as a WorkspaceBootstrapFile alongside AGENTS.md and IDENTITY.md | ✓        |
| Inject as separate context section     | Create a dedicated 'Project Context' section in the system prompt              |          |
| Append to AGENTS.md content            | Merge PROJECT.md content into the AGENTS.md bootstrap file                     |          |

**User's choice:** Inject as bootstrap file

### Q3: When should injection happen?

| Option                                    | Description                                          | Selected |
| ----------------------------------------- | ---------------------------------------------------- | -------- |
| Every run including initial (Recommended) | PROJECT.md is always included as a bootstrap file    | ✓        |
| Post-compaction only                      | PROJECT.md only injected during post-compaction sync |          |

**User's choice:** Every run including initial

### Q4: How to handle sub-projects?

| Option                                | Description                                       | Selected |
| ------------------------------------- | ------------------------------------------------- | -------- |
| Nearest PROJECT.md wins (Recommended) | Walk-up stops at first PROJECT.md found           | ✓        |
| Load both parent and sub-project      | Inject both the sub-project and parent PROJECT.md |          |
| Always use root project               | Walk up to top-level project directory            |          |

**User's choice:** Nearest PROJECT.md wins

---

## Bootstrap Hook Integration

### Q1: How should the hook know which project to inject?

| Option                                       | Description                                                | Selected |
| -------------------------------------------- | ---------------------------------------------------------- | -------- |
| Channel config maps to project (Recommended) | A config field specifies which project directory to load   | ✓        |
| Convention-based matching                    | Channel/agent name matched against project directory names |          |
| All projects injected                        | Every project's PROJECT.md injected for every channel      |          |

**User's choice:** Channel config maps to project

### Q2: Where should the project mapping be configured?

| Option                                 | Description                                            | Selected |
| -------------------------------------- | ------------------------------------------------------ | -------- |
| Agent config (per-agent) (Recommended) | In the agent's config file (agents.project: myproject) | ✓        |
| Channel config (per-channel)           | In the channel configuration                           |          |
| Both agent and channel                 | Check agent config first, fall back to channel config  |          |

**User's choice:** Agent config (per-agent)

### Q3: How should bootstrap hook and cwd pickup coexist?

| Option                                          | Description                                                             | Selected |
| ----------------------------------------------- | ----------------------------------------------------------------------- | -------- |
| Both active, cwd wins on conflict (Recommended) | Both mechanisms run; cwd version takes priority if both find PROJECT.md | ✓        |
| Bootstrap hook only for non-cwd agents          | Skip hook if cwd pickup found PROJECT.md                                |          |
| Always use bootstrap hook                       | Disable cwd pickup entirely                                             |          |

**User's choice:** Both active, cwd wins on conflict

---

## Capability Tags in IDENTITY.md

### Q1: How should capabilities be defined?

| Option                                                | Description                                                                     | Selected |
| ----------------------------------------------------- | ------------------------------------------------------------------------------- | -------- |
| Bullet list with comma-separated values (Recommended) | `- capabilities: code, testing, ui` parsed by extending parseIdentityMarkdown() | ✓        |
| YAML frontmatter array                                | Frontmatter block with capabilities array                                       |          |

**User's choice:** Bullet list with comma-separated values
**Notes:** User asked about YAML benefits; explained that IDENTITY.md has no frontmatter currently, and the existing bullet parser already handles key:value pairs cleanly.

### Q2: How should capability matching work?

| Option                  | Description                                                              | Selected |
| ----------------------- | ------------------------------------------------------------------------ | -------- |
| ANY match (Recommended) | Agent matches if it has at least one of the task's required capabilities | ✓        |
| ALL match               | Agent must have all capabilities the task requires                       |          |
| Weighted scoring        | Score agents by capability overlap count                                 |          |

**User's choice:** ANY match

### Q3: What happens with no capabilities defined?

| Option                              | Description                          | Selected |
| ----------------------------------- | ------------------------------------ | -------- |
| Can claim any task (Recommended)    | No capabilities = wildcard           |          |
| Cannot claim capability-gated tasks | No caps = no matches for gated tasks | ✓        |
| Warn and treat as wildcard          | Log warning, then allow all          |          |

**User's choice:** Cannot claim capability-gated tasks

---

## Context Content and Format

### Q1: What project content should agents receive?

| Option                             | Description                                   | Selected |
| ---------------------------------- | --------------------------------------------- | -------- |
| Full PROJECT.md file (Recommended) | Inject entire file as-is, typically under 1KB | ✓        |
| Summary with queue status          | Condensed summary with current queue state    |          |
| Frontmatter only                   | Only YAML frontmatter metadata                |          |

**User's choice:** Full PROJECT.md file

### Q2: Where should the capability matcher live?

| Option                                        | Description                                        | Selected |
| --------------------------------------------- | -------------------------------------------------- | -------- |
| New file: capability-matcher.ts (Recommended) | Dedicated module with matchCapabilities() function | ✓        |
| Add to types.ts                               | Small function alongside existing types            |          |
| Inline in heartbeat code (Phase 6)            | Defer to Phase 6                                   |          |

**User's choice:** New file: src/projects/capability-matcher.ts

### Q3: Should PROJECT.md inject on heartbeat runs?

| Option                               | Description                                         | Selected |
| ------------------------------------ | --------------------------------------------------- | -------- |
| Skip on heartbeat runs (Recommended) | Heartbeats use lightweight context, skip PROJECT.md | ✓        |
| Include on heartbeat runs            | Always inject even during heartbeat cycles          |          |

**User's choice:** Skip on heartbeat runs

---

## Claude's Discretion

- Internal implementation of cwd walk-up
- Bootstrap hook registration pattern
- Test approach for bootstrap file injection
- Whether to add capabilities to AgentIdentityFile type or keep separate

## Deferred Ideas

None
