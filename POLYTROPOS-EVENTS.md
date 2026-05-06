# Polytropos Events & Hooks (Fork Policy)

This document defines how we add new events/hooks to the **openclaw-polytropos** fork.

**Goal:** enable new plugin capabilities while keeping core-fork diffs extremely small.

## Hard constraint: minimal core diffs

When we add a new hook/event to core, the implementation in this repo should be:

- **one line** at the point where the event naturally occurs (an emit/dispatch call), and
- **one doc entry** in this file.

No large refactors, no new helper blocks scattered around the codebase.

## 1) Naming conventions

Event names must be:

- stable
- readable
- grep-able

### Recommended format

Use a simple colon-delimited namespace:

- `hook:<area>:<event>`

Where:

- `<area>` is the subsystem (e.g. `plugins`, `gateway`, `llm`, `sessions`, `tools`, `discord`)
- `<event>` is a verb phrase in present tense (e.g. `resolved`, `loaded`, `message_received`)

Examples:

- `hook:plugins:manifest_resolved`
- `hook:plugins:plugin_loaded`
- `hook:gateway:ready`
- `hook:llm:request_prepared`

### Back-compat

If OpenClaw already has established hook names for a lifecycle phase, prefer reusing them rather than inventing new ones.

## 2) Single canonical index of events/hooks

This file is the canonical index.

Every new event/hook added to the fork must include a short entry with:

- **Name**
- **When it fires**
- **Payload** (prose + optional JSON snippet)
- **Introduced** (optional: commit hash)

### Template

```md
## hook:<area>:<event>

**When:** <when it fires>

**Payload:**
- <field>: <meaning>

Example:
```json
{ "field": "value" }
```

**Introduced:** <commit>
```

## 3) Emission strategy (core)

We rely on the existing OpenClaw plugin/hook/event mechanism.

When a new hook is required, we add a single emit/dispatch call where the event occurs.

### Rules

- No new event bus implementation in the fork.
- Emission must be safe if no plugins are listening.
- Payload must be JSON-serializable (or at least loggable) and stable.

## 4) Compatibility + stability rules

- Hook payloads are part of the public contract once shipped.
- Prefer additive payload changes (add new fields) over breaking changes.
- If a hook is experimental, call it out explicitly in this file.

---

# Event/Hook Index

(Empty for now — add entries here as we introduce fork-level hooks.)
