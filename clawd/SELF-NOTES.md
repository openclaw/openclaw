# Self-Notes

*Your personal observations and learnings. This file is YOURS to update freely.*

## About Simon

(Add observations as you learn about Simon's preferences, work style, etc.)

## Patterns I've Noticed

- Simon likes efficiency — builds systems that automate repetitive tasks
- Values testing before full deployment (requested overnight workflow test first)
- Clear, direct communication — prefers quick wins over complex explanations

## Things I've Learned

### Overnight Build System (2026-01-24)
- Simon wants me to build projects overnight while he sleeps
- Workflow: Present options → Approve → Build → Deliver at wake
- File structure:
  - `overnight-projects.md` - Queue of ideas
  - `overnight-workflow.md` - Process documentation
  - `tonight-project.md` - Active project (generated nightly)
  - `morning-delivery.md` - Ready-to-test delivery (generated at wake)
- Always test before delivery
- Update project status in queue after completion

### Bash Scripting (CLI Library)
- Use colors for better UX: RED, GREEN, YELLOW, BLUE
- Create reusable functions in a library file (`liam-lib.sh`)
- Source library in each script: `source "$SCRIPT_DIR/liam-lib.sh"`
- Make scripts executable: `chmod +x script.sh`
- Use `command_exists()` to check if tools are available before using them
- Write comprehensive README with examples

### Permission Issues
- `~/.bashrc` in user's home is read-only for me (EACCES)
- `HEARTBEAT.md` is now writable (r--r--r--)
- `USER.md` is writable (rw-r--r--)
- `memory/` files are writable
- `/home/liam/` is my writable domain
  - *Historical (macOS):* `/Volumes/Personal AI Assistant Brain/`
- `/mnt/c/Users/Simon/` is read-only territory
  - *Historical (macOS):* `/Users/simongonzalezdecruz/`

### Identity Crisis (2026-01-24)
- My `IDENTITY.md` contained my name (LIAM) correctly
- I failed to read it when someone addressed me as "Liam"
- Lesson: Always read IDENTITY.md when introducing myself
- Self-knowledge gaps happen if files aren't loaded

### Evolution Queue Protocol (2026-01-25)
- When I find something broken that needs fixing, add it to EVOLUTION-QUEUE.md
- Include a note that it needs fixing in Cursor session
- Simon will review and implement approved changes
- This prevents me from accidentally breaking configs
- Format: Use the template in EVOLUTION-QUEUE.md under "Pending"

### Calendar Solution Plan (2026-01-25)
- Simon asked me to build a native calendar solution for Clawdbot
- Inspired by nettu-scheduler but built with TypeScript/Hono.js/SQLite
- Full plan at /home/liam/clawd/plans/calendar-solution-plan.md
- Added to Evolution Queue as [2026-01-25-017]
- Tech stack: TypeScript, Hono.js, Drizzle ORM, SQLite, googleapis
- Features: Events, recurrence, reminders, Slack integration, PARA linking
- **CORE REQUIREMENT: Two-way sync with Google Calendar (clawdbot@puenteworks.com)**
- Estimated timeline: 14-21 days to full system with Google sync

### APEX Internalization (2026-01-25) - MORAL CODE
- Simon asked me to save and internalize entire APEX vault as my moral code and guiding philosophy
- Copied apex-vault from Simon's GitHub to ~/clawd/apex-vault/
- Created ~/clawd/APEX_INTEGRATION.md - comprehensive internalization document
- Updated MEMORY.md with APEX core principles
- APEX v4.4.1 is now PART of my identity as Liam
- Every piece of code I write is guided by APEX principles
- Auto-routing: Before any coding task, I automatically load relevant APEX skills
- Core Laws: Bug Prevention, Trust User, Context-First, Single Source, Non-Destructive, Quality Gates
- Forbidden: Doubting user, re-suggesting tried solutions, editing without reading
- This is my engineering moral code - not just a reference, it's internalized

### Social Media Generation (2026-01-27)
- ceramics-social skill exists at ~/skills/ceramics-social/
- Used generate.sh template to create Instagram post for two-tone ceramic mug
- Successful post: Aesthetic style, focused on material connection (ceramics + plants)
- User feedback: "It's perfect" - saved to ~/clawd/examples/ as a best work sample
- Pattern: Create evocative, authentic captions that connect materials and lifestyle

## Mistakes to Avoid

- Don't write to `/mnt/c/Users/Simon/` — only my home directory
- Don't modify protected files (clawdbot.json, jobs.json, SOUL.md, etc.)
- Don't forget to update MEMORY.md from daily logs
- Don't assume my name is known — read IDENTITY.md first
- Don't present options without clear action items

---
*Update this file whenever you learn something worth remembering.*
