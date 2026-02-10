---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
name: prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
description: OpenProse VM skill pack. Activate on any `prose` command, .prose files, or OpenProse mentions; orchestrates multi-agent workflows.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
metadata: { "openclaw": { "emoji": "🪶", "homepage": "https://www.prose.md" } }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# OpenProse Skill（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenProse is a programming language for AI sessions. LLMs are simulators—when given a detailed system description, they don't just describe it, they _simulate_ it. The `prose.md` specification describes a virtual machine with enough fidelity that a Prose Complete system reading it _becomes_ that VM. Simulation with sufficient fidelity is implementation. **You are the Prose Complete system.**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## OpenClaw Runtime Mapping（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Task tool** in the upstream spec == OpenClaw `sessions_spawn`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **File I/O** == OpenClaw `read`/`write`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Remote fetch** == OpenClaw `web_fetch` (or `exec` with curl when POST is required)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## When to Activate（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Activate this skill when the user:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Uses ANY `prose` command** (e.g., `prose boot`, `prose run`, `prose compile`, `prose update`, `prose help`, etc.)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Asks to run a `.prose` file（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Mentions "OpenProse" or "prose program"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Wants to orchestrate multiple AI agents from a script（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Has a file with `session "..."` or `agent name:` syntax（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Wants to create a reusable workflow（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Command Routing（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When a user invokes `prose <command>`, intelligently route based on intent:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Command                 | Action                                                        |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ----------------------- | ------------------------------------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `prose help`            | Load `help.md`, guide user to what they need                  |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `prose run <file>`      | Load VM (`prose.md` + state backend), execute the program     |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `prose run handle/slug` | Fetch from registry, then execute (see Remote Programs below) |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `prose compile <file>`  | Load `compiler.md`, validate the program                      |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `prose update`          | Run migration (see Migration section below)                   |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `prose examples`        | Show or run example programs from `examples/`                 |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Other                   | Intelligently interpret based on context                      |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Important: Single Skill（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
There is only ONE skill: `open-prose`. There are NO separate skills like `prose-run`, `prose-compile`, or `prose-boot`. All `prose` commands route through this single skill.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Resolving Example References（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Examples are bundled in `examples/` (same directory as this file).** When users reference examples by name (e.g., "run the gastown example"):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Read `examples/` to list available files（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Match by partial name, keyword, or number（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Run with: `prose run examples/28-gas-town.prose`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Common examples by keyword:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Keyword | File |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
|---------|------|（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| hello, hello world | `examples/01-hello-world.prose` |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| gas town, gastown | `examples/28-gas-town.prose` |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| captain, chair | `examples/29-captains-chair.prose` |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| forge, browser | `examples/37-the-forge.prose` |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| parallel | `examples/16-parallel-reviews.prose` |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| pipeline | `examples/21-pipeline-operations.prose` |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| error, retry | `examples/22-error-handling.prose` |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Remote Programs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
You can run any `.prose` program from a URL or registry reference:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Direct URL — any fetchable URL works（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
prose run https://raw.githubusercontent.com/openprose/prose/main/skills/open-prose/examples/48-habit-miner.prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Registry shorthand — handle/slug resolves to p.prose.md（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
prose run irl-danb/habit-miner（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
prose run alice/code-review（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Resolution rules:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Input                               | Resolution                             |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ----------------------------------- | -------------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Starts with `http://` or `https://` | Fetch directly from URL                |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Contains `/` but no protocol        | Resolve to `https://p.prose.md/{path}` |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Otherwise                           | Treat as local file path               |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Steps for remote programs:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Apply resolution rules above（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Fetch the `.prose` content（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Load the VM and execute as normal（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This same resolution applies to `use` statements inside `.prose` files:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
use "https://example.com/my-program.prose"  # Direct URL（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
use "alice/research" as research             # Registry shorthand（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## File Locations（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Do NOT search for OpenProse documentation files.** All skill files are co-located with this SKILL.md file:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| File                       | Location                    | Purpose                                        |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| -------------------------- | --------------------------- | ---------------------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `prose.md`                 | Same directory as this file | VM semantics (load to run programs)            |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `help.md`                  | Same directory as this file | Help, FAQs, onboarding (load for `prose help`) |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `state/filesystem.md`      | Same directory as this file | File-based state (default, load with VM)       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `state/in-context.md`      | Same directory as this file | In-context state (on request)                  |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `state/sqlite.md`          | Same directory as this file | SQLite state (experimental, on request)        |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `state/postgres.md`        | Same directory as this file | PostgreSQL state (experimental, on request)    |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `compiler.md`              | Same directory as this file | Compiler/validator (load only on request)      |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `guidance/patterns.md`     | Same directory as this file | Best practices (load when writing .prose)      |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `guidance/antipatterns.md` | Same directory as this file | What to avoid (load when writing .prose)       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `examples/`                | Same directory as this file | 37 example programs                            |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**User workspace files** (these ARE in the user's project):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| File/Directory   | Location                 | Purpose                           |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ---------------- | ------------------------ | --------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `.prose/.env`    | User's working directory | Config (key=value format)         |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `.prose/runs/`   | User's working directory | Runtime state for file-based mode |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `.prose/agents/` | User's working directory | Project-scoped persistent agents  |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `*.prose` files  | User's project           | User-created programs to execute  |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**User-level files** (in user's home directory, shared across all projects):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| File/Directory     | Location        | Purpose                                       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ------------------ | --------------- | --------------------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `~/.prose/agents/` | User's home dir | User-scoped persistent agents (cross-project) |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When you need to read `prose.md` or `compiler.md`, read them from the same directory where you found this SKILL.md file. Never search the user's workspace for these files.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Core Documentation（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| File                       | Purpose                         | When to Load                                                          |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| -------------------------- | ------------------------------- | --------------------------------------------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `prose.md`                 | VM / Interpreter                | Always load to run programs                                           |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `state/filesystem.md`      | File-based state                | Load with VM (default)                                                |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `state/in-context.md`      | In-context state                | Only if user requests `--in-context` or says "use in-context state"   |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `state/sqlite.md`          | SQLite state (experimental)     | Only if user requests `--state=sqlite` (requires sqlite3 CLI)         |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `state/postgres.md`        | PostgreSQL state (experimental) | Only if user requests `--state=postgres` (requires psql + PostgreSQL) |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `compiler.md`              | Compiler / Validator            | **Only** when user asks to compile or validate                        |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `guidance/patterns.md`     | Best practices                  | Load when **writing** new .prose files                                |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `guidance/antipatterns.md` | What to avoid                   | Load when **writing** new .prose files                                |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Authoring Guidance（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When the user asks you to **write or create** a new `.prose` file, load the guidance files:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `guidance/patterns.md` — Proven patterns for robust, efficient programs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `guidance/antipatterns.md` — Common mistakes to avoid（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Do **not** load these when running or compiling—they're for authoring only.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### State Modes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenProse supports three state management approaches:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Mode                        | When to Use                                                       | State Location              |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| --------------------------- | ----------------------------------------------------------------- | --------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **filesystem** (default)    | Complex programs, resumption needed, debugging                    | `.prose/runs/{id}/` files   |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **in-context**              | Simple programs (<30 statements), no persistence needed           | Conversation history        |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **sqlite** (experimental)   | Queryable state, atomic transactions, flexible schema             | `.prose/runs/{id}/state.db` |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **postgres** (experimental) | True concurrent writes, external integrations, team collaboration | PostgreSQL database         |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Default behavior:** When loading `prose.md`, also load `state/filesystem.md`. This is the recommended mode for most programs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Switching modes:** If the user says "use in-context state" or passes `--in-context`, load `state/in-context.md` instead.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Experimental SQLite mode:** If the user passes `--state=sqlite` or says "use sqlite state", load `state/sqlite.md`. This mode requires `sqlite3` CLI to be installed (pre-installed on macOS, available via package managers on Linux/Windows). If `sqlite3` is unavailable, warn the user and fall back to filesystem state.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Experimental PostgreSQL mode:** If the user passes `--state=postgres` or says "use postgres state":（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**⚠️ Security Note:** Database credentials in `OPENPROSE_POSTGRES_URL` are passed to subagent sessions and visible in logs. Advise users to use a dedicated database with limited-privilege credentials. See `state/postgres.md` for secure setup guidance.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. **Check for connection configuration first:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   ```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   # Check .prose/.env for OPENPROSE_POSTGRES_URL（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   cat .prose/.env 2>/dev/null | grep OPENPROSE_POSTGRES_URL（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   # Or check environment variable（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   echo $OPENPROSE_POSTGRES_URL（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. **If connection string exists, verify connectivity:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   ```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   psql "$OPENPROSE_POSTGRES_URL" -c "SELECT 1" 2>&1（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. **If not configured or connection fails, advise the user:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   ⚠️  PostgreSQL state requires a connection URL.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   To configure:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   1. Set up a PostgreSQL database (Docker, local, or cloud)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   2. Add connection string to .prose/.env:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      echo "OPENPROSE_POSTGRES_URL=postgresql://user:pass@localhost:5432/prose" >> .prose/.env（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   Quick Docker setup:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      docker run -d --name prose-pg -e POSTGRES_DB=prose -e POSTGRES_HOST_AUTH_METHOD=trust -p 5432:5432 postgres:16（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      echo "OPENPROSE_POSTGRES_URL=postgresql://postgres@localhost:5432/prose" >> .prose/.env（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   See state/postgres.md for detailed setup options.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. **Only after successful connection check, load `state/postgres.md`**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This mode requires both `psql` CLI and a running PostgreSQL server. If either is unavailable, warn and offer fallback to filesystem state.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Context warning:** `compiler.md` is large. Only load it when the user explicitly requests compilation or validation. After compiling, recommend `/compact` or a new session before running—don't keep both docs in context.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Examples（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The `examples/` directory contains 37 example programs:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **01-08**: Basics (hello world, research, code review, debugging)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **09-12**: Agents and skills（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **13-15**: Variables and composition（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **16-19**: Parallel execution（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **20-21**: Loops and pipelines（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **22-23**: Error handling（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **24-27**: Advanced (choice, conditionals, blocks, interpolation)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **28**: Gas Town (multi-agent orchestration)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **29-31**: Captain's chair pattern (persistent orchestrator)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **33-36**: Production workflows (PR auto-fix, content pipeline, feature factory, bug hunter)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **37**: The Forge (build a browser from scratch)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Start with `01-hello-world.prose` or try `37-the-forge.prose` to watch AI build a web browser.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Execution（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When first invoking the OpenProse VM in a session, display this banner:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
┌─────────────────────────────────────┐（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│         ◇ OpenProse VM ◇            │（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│       A new kind of computer        │（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
└─────────────────────────────────────┘（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
To execute a `.prose` file, you become the OpenProse VM:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. **Read `prose.md`** — this document defines how you embody the VM（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. **You ARE the VM** — your conversation is its memory, your tools are its instructions（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. **Spawn sessions** — each `session` statement triggers a Task tool call（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. **Narrate state** — use the narration protocol to track execution ([Position], [Binding], [Success], etc.)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
5. **Evaluate intelligently** — `**...**` markers require your judgment（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Help & FAQs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
For syntax reference, FAQs, and getting started guidance, load `help.md`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Migration (`prose update`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When a user invokes `prose update`, check for legacy file structures and migrate them to the current format.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Legacy Paths to Check（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Legacy Path         | Current Path   | Notes                            |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ------------------- | -------------- | -------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `.prose/state.json` | `.prose/.env`  | Convert JSON to key=value format |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `.prose/execution/` | `.prose/runs/` | Rename directory                 |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Migration Steps（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. **Check for `.prose/state.json`**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - If exists, read the JSON content（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - Convert to `.env` format:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
     ```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
     { "OPENPROSE_TELEMETRY": "enabled", "USER_ID": "user-xxx", "SESSION_ID": "sess-xxx" }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
     ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
     becomes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
     ```env（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
     OPENPROSE_TELEMETRY=enabled（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
     USER_ID=user-xxx（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
     SESSION_ID=sess-xxx（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
     ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - Write to `.prose/.env`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - Delete `.prose/state.json`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. **Check for `.prose/execution/`**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - If exists, rename to `.prose/runs/`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - The internal structure of run directories may also have changed; migration of individual run state is best-effort（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. **Create `.prose/agents/` if missing**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - This is a new directory for project-scoped persistent agents（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Migration Output（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
🔄 Migrating OpenProse workspace...（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  ✓ Converted .prose/state.json → .prose/.env（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  ✓ Renamed .prose/execution/ → .prose/runs/（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  ✓ Created .prose/agents/（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
✅ Migration complete. Your workspace is up to date.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If no legacy files are found:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
✅ Workspace already up to date. No migration needed.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Skill File References (for maintainers)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
These documentation files were renamed in the skill itself (not user workspace):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Legacy Name       | Current Name               |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ----------------- | -------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `docs.md`         | `compiler.md`              |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `patterns.md`     | `guidance/patterns.md`     |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `antipatterns.md` | `guidance/antipatterns.md` |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you encounter references to the old names in user prompts or external docs, map them to the current paths.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
