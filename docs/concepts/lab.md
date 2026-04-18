---
title: "Lab"
summary: "Experimental feature umbrella for repo-owned prompt and behavior experiments"
read_when:
  - You see `/lab` commands and want to know what Lab controls
  - You want to enable custom prompt addenda for a workspace
  - You want to understand which Lab files are live vs. instructional
---

# Lab

Lab is OpenClaw's **experimental feature umbrella** for repo-owned agent
behavior experiments.

Right now, the first Lab feature is **custom overrides**:

- a model-level `AGENTS.md` addendum
- an optional higher-priority agent-specific `AGENTS.md` addendum

Lab is intentionally separate from stable config because this surface is still
changing. Use it when you want to tune agent behavior without pretending the
contract is already permanent.

## Commands

Use the Lab command menu from chat:

```txt
/lab
/lab custom status
/lab enable custom
/lab disable custom
```

Notes:

- `/lab` is the entry point and shows the currently available Lab features.
- `custom` is the current feature key.
- the user-facing name is **custom overrides**
- the stored config path is still:

```toml
[plugins.entries.lab.config.modelOverrides]
enabled = true
```

## What custom overrides do

When custom overrides are enabled, OpenClaw can inject extra `AGENTS.md`
instructions from the workspace into the system prompt.

Live files:

```txt
<workspace>/.openclaw/lab/overrides/<model-id>/AGENTS.md
<workspace>/.openclaw/lab/agents/<agent-id>/overrides/<model-id>/AGENTS.md
```

See [Custom Overrides](/concepts/lab-custom-overrides) for the full path and
precedence rules.

## Current prompt order

For the GPT-5.4 Lab path that ships in this repo, prompt ordering is:

```txt
1. Lab model addendum
2. Lab agent addendum
3. root AGENTS.md
4. other prompt/context files
5. FINAL_REMINDER.md
```

That means Lab addenda are a **higher-priority overlay** on top of the normal
repo `AGENTS.md`.

Lab addenda are also treated like normal prompt files for:

- prompt reporting
- truncation
- context budgeting

They are not a hidden side channel.

## Status and debugging

`/lab custom status` reports:

- whether the Lab plugin is enabled
- whether custom overrides are enabled
- current model
- current agent
- resolved workspace
- exact override paths checked
- active addenda
- whether any active addendum was truncated

That output is the fastest way to debug “why is my override not loading?”

## Scope and expectations

Lab is for **experiments**. That means:

- commands and feature names may change faster than stable config
- prompt file structure may evolve
- docs should describe the current shipped behavior, not promise a long-term API

If you want stable workspace customization, keep using the normal workspace
files (`AGENTS.md`, `SOUL.md`, `IDENTITY.md`, etc.). Use Lab when you want an
explicit experimental overlay.
