# Spec-First Skill 📋

Simple spec-first task execution.

## Usage

```bash
# Load skill
openclaw skills load spec-first

# Or in chat
/spec load spec-first
```

## Commands

```
/spec clarify "Build a login system"
/spec defaults
/spec draft
/spec approve
/spec execute
```

## Example

```
/spec clarify "Build a TODO app"
→ 📋 Clarification Session: spec-123
→ ❓ Questions (3):
→   q-0. Tech stack? (Next.js, Express, Python)
→   q-1. Database? (PostgreSQL, MongoDB, SQLite)
→   q-2. Auth needed? (JWT, Session, None)

/spec defaults
→ ✅ Applied 3 defaults

/spec draft
→ 📝 Draft Spec Generated
→ # Spec: TODO App
→ ## Goal: Build a simple TODO app...

/spec approve
→ ✅ Spec Approved!

/spec execute
→ 🚀 Execution Complete
```

## Files

- `SKILL.md` - Documentation
- `index.ts` - Implementation
- `README.md` - This file

## License

MIT
