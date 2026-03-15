---
name: spec-first
description: Spec-first task execution with AI clarification. Analyze requirements, ask questions, generate specs, and execute systematically.
metadata: { "openclaw": { "emoji": "📋", "requires": { "bins": [] } } }
---

# Spec-First Skill 📋

**Location:** `{baseDir}/`

**Purpose:** Implement spec-first workflow: Clarify → Spec → Execute → Validate

## Quick Start

```
/spec clarify "Build a login system"
/spec defaults
/spec draft
/spec approve
/spec execute
```

## Commands

| Command | Description |
|---------|-------------|
| `/spec clarify "<request>"` | Start clarification |
| `/spec defaults` | Use recommended defaults |
| `/spec answer --q0 <a> --q1 <a>` | Custom answers |
| `/spec draft` | Generate draft spec |
| `/spec approve` | Approve spec |
| `/spec execute` | Execute spec |
| `/spec status` | Show status |

## Example

```
/spec clarify "Build a TODO app"
→ AI asks questions

/spec defaults
→ Applied defaults

/spec draft
→ Generated spec

/spec approve
→ Spec approved

/spec execute
→ Executing tasks...
```

## Files

- `index.ts` - Main implementation
- `clarification.ts` - Clarification logic
- `executor.ts` - Task execution
- `SKILL.md` - This file

## Related

- `coding-agent` - For complex coding
- `github` - For PRs
- `memory` - For storage

---

**Version:** 1.0.0  
**Author:** OpenClaw Team
