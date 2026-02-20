# Phase 01: Core Documentator Agent Playbook

This phase creates the **openclaw-documentator** — a read-only investigator agent skill that teaches AI agents how to systematically explore and answer questions about the OpenClaw codebase. By the end of this phase, there will be a fully functional `skills/documentator/SKILL.md` playbook that any AI agent can use to investigate the codebase on demand and produce structured Markdown answers for other agents. The documentator itself never modifies code — it only reads, searches, and reports.

## Tasks

- [x] Deep-dive exploration of the OpenClaw codebase and create a structured reference map:
  > Completed 2026-02-19: Explored all ~50 src/ subsystems, 31 extensions, 51 skills, 4 entry points, 5 architectural patterns (DI, channel abstraction, plugin loading, dual-layer hooks, redaction-based config security), testing patterns (Vitest, colocated tests, E2E with Docker), and Mintlify docs structure. Results saved to `Auto Run Docs/Initiation/Working/codebase-exploration.md`.
  - Read `AGENTS.md`, `package.json`, `pnpm-workspace.yaml`, and `tsconfig.json` to understand project conventions
  - Explore every top-level directory and catalog its purpose (src/, extensions/, skills/, apps/, docs/, ui/, vendor/, scripts/, test/, packages/, Swabble/)
  - Map all `src/` subdirectories (there are ~47 subsystems) — for each one, note its purpose, key files, and rough size
  - Catalog all `extensions/` packages with their names and what they integrate with
  - Catalog all `skills/` with their names
  - Identify key entry points: `openclaw.mjs`, `src/entry.ts`, `src/index.ts`, `src/cli/program.js`
  - Identify key architectural patterns: dependency injection via `createDefaultDeps`, channel abstraction, plugin loading, hook system, config encryption
  - Note testing patterns: colocated `*.test.ts`, vitest config, E2E tests in `test/`
  - Note documentation patterns: Mintlify docs in `docs/`, 44 subdirectories
  - Save all findings as a structured Markdown file at `Auto Run Docs/Initiation/Working/codebase-exploration.md` with YAML front matter:
    - type: research, title: "OpenClaw Codebase Exploration", tags: [codebase, structure, reference]
  - Use wiki-links like `[[SKILL.md]]` to reference the eventual skill file

- [x] Create the documentator skill file with metadata, purpose statement, and comprehensive codebase structure map:
  > Completed 2026-02-19: Created `skills/documentator/SKILL.md` with YAML front matter (name, description, emoji metadata), Purpose & Constraints section, comprehensive Codebase Structure Map (annotated directory tree), Key Files Reference Table (3 tables: entry points, core modules, config/build), Module Boundary Guide (7 domain categories mapping user concepts to src/ directories), Extension & Plugin Registry (31 extensions in 3 categories), and Skills Catalog (51 skills in 11 categories). Based on exploration notes, coding-agent SKILL.md format, and AGENTS.md conventions.
  - Read the exploration notes from `Auto Run Docs/Initiation/Working/codebase-exploration.md`
  - Read `skills/coding-agent/SKILL.md` to understand the existing skill file format (YAML front matter with name, description, metadata)
  - Read `AGENTS.md` to understand the conventions for agent instructions
  - Create `skills/documentator/SKILL.md` with the following sections:
    - **YAML front matter**: name: documentator, description: "Read-only codebase investigator that answers questions about OpenClaw's architecture, code, and systems. Produces structured Markdown for AI agent consumption.", metadata with openclaw emoji and no binary requirements
    - **Purpose & Constraints**: explain this is a read-only agent, must never modify files, output is Markdown for other AI agents
    - **Codebase Structure Map**: comprehensive directory tree with purpose annotations for every major directory and subdirectory under src/
    - **Key Files Reference Table**: table of the most important files (entry points, config, core modules) with file paths and one-line descriptions
    - **Module Boundary Guide**: describe how src/ subdirectories map to features (e.g., src/telegram = Telegram channel, src/gateway = control plane server, src/agents = Pi agent implementation, etc.)
    - **Extension & Plugin Registry**: list all extensions/ packages and what they do
    - **Skills Catalog**: list all skills/ and their purposes

- [x] Add investigation methodology and search strategy sections to the SKILL.md:
  > Completed 2026-02-19: Added three comprehensive sections to `skills/documentator/SKILL.md`: **Investigation Methodology** (7-step process with keyword-to-module mapping table covering 17 keyword groups, entry point finding, code path tracing, test/doc cross-referencing, cross-module interaction guidance), **Search Strategy Guide** (grep patterns for definitions/usages/hooks/config, glob pattern table, monorepo search guidance, 5 search tips, 12-row starting points table), and **Dependency Tracing** (npm dep tracing, internal module dependency patterns, full 5-stage extension loading mechanism walkthrough from discovery → manifest → loading → registration → activation with file references).
  - Read the current `skills/documentator/SKILL.md` to understand what's already written
  - Add an **Investigation Methodology** section with:
    - Step-by-step approach: 1) Understand the question scope, 2) Identify which module(s) are involved, 3) Find entry points, 4) Trace code paths, 5) Check tests for behavior confirmation, 6) Check docs for intended behavior, 7) Synthesize findings
    - How to identify which module handles a given feature (keyword mapping from user concepts to src/ directories)
    - How to trace a code path: start from entry point, follow imports, check for dependency injection via createDefaultDeps
    - How to find related files: same-directory siblings, test files (*.test.ts), doc files in docs/
    - How to understand cross-module interactions: check imports, grep for function/class usage across modules
  - Add a **Search Strategy Guide** section with:
    - Effective grep patterns: searching for class/function definitions, finding all usages, tracing imports
    - Glob patterns: finding all files in a module (`src/telegram/**/*.ts`), finding test files, finding config files
    - How to search across monorepo workspaces (root src/ vs extensions/ vs packages/)
    - Tips for searching: prefer exact identifiers over fuzzy terms, check both src/ and extensions/ for channel code, use test files to understand expected behavior
    - Common search starting points for different question types (channel questions → src/channels + src/<channel-name>, plugin questions → src/plugins + extensions/, config questions → src/config, CLI questions → src/cli + src/commands)
  - Add a **Dependency Tracing** section with:
    - How to trace npm dependencies: check package.json dependencies and devDependencies
    - How to trace internal module dependencies: follow import statements
    - How to understand the extension loading mechanism: src/channels/plugins/ loads extensions/*

- [x] Add output formatting rules and example investigation workflows to the SKILL.md:
  > Completed 2026-02-19: Added three sections to `skills/documentator/SKILL.md`: **Output Format Specification** (5-part required answer structure — one-line summary, key files table, how-it-works flow, related modules, code snippets — plus 8 formatting rules), **Example Investigation Workflows** (5 worked examples: WhatsApp message routing tracing inbound from Baileys→monitor→routing→agent and outbound back, extension channel creation covering ChannelPlugin interface and registration pattern, LLM provider enumeration covering 16+ providers and 6 API protocols, cron system lifecycle from definition→scheduling→execution→delivery with state tracking, browser automation architecture covering HTTP bridge→Playwright/CDP→Chrome with ref system), and **Quick Reference Cheat Sheet** (17-row module mapping table + 10-row investigation shortcuts table).
  - Read the current `skills/documentator/SKILL.md`
  - Add an **Output Format Specification** section with:
    - All answers must be structured Markdown
    - Start with a one-line summary answering the question directly
    - Follow with a "Key Files" section listing relevant file paths with line numbers where applicable
    - Include a "How It Works" section with explanation of the code flow
    - Include a "Related Modules" section noting connected systems
    - Use fenced code blocks for code snippets with file path annotations
    - Use tables for comparing options or listing items
    - Keep answers factual — cite file paths and line numbers, never guess
    - Format: `file_path:line_number` for code references (e.g., `src/telegram/bot.ts:42`)
  - Add an **Example Investigation Workflows** section with 5 worked examples:
    - Example 1: "How does WhatsApp message routing work?" — trace from src/channels → src/routing → src/web (WhatsApp via Baileys)
    - Example 2: "How do I add a new extension channel?" — examine extensions/ structure, src/channels/plugins/, plugin-sdk
    - Example 3: "What LLM providers are supported?" — check src/providers/, list all provider files
    - Example 4: "How does the cron system work?" — trace src/cron/ module
    - Example 5: "How does the browser automation work?" — trace src/browser/ with Playwright integration
    - Each example should show: the question, which modules to check first, what to grep for, expected answer structure
  - Add a **Quick Reference Cheat Sheet** section with:
    - One-liner mappings: "channels → src/channels + src/<name>", "CLI commands → src/commands/", "gateway API → src/gateway/", etc.
    - Common investigation shortcuts

- [x] Validate the documentator by running a test investigation and saving the result:
  > Completed 2026-02-19: Investigated "How does the hook lifecycle system work in OpenClaw?" following all 7 playbook methodology steps. Read 15+ source files across `src/plugins/` and `src/hooks/`, traced both Layer 1 (typed plugin hooks with 14 named events, priority-sorted execution via `HookRunner`) and Layer 2 (internal event bus with `type:action` string-keyed dispatch). Identified 5 active Layer 1 trigger sites and 4 Layer 2 trigger sites. Confirmed 9 of 14 typed hooks are infrastructure-ready but not yet triggered. Cross-referenced 11 test files and 6 documentation sources. Reviewed output against playbook format spec — all 5 required sections present, all 8 formatting rules followed. No SKILL.md updates needed. Report saved to `Auto Run Docs/Initiation/Working/test-investigation-hooks.md`.
  - Read the completed `skills/documentator/SKILL.md` in full
  - Choose a non-trivial investigation question: "How does the hook lifecycle system work in OpenClaw?"
  - Follow the playbook methodology step by step:
    - Identify relevant modules (src/hooks/)
    - Find entry points and key files
    - Trace the code flow
    - Check test files for behavior confirmation
    - Check docs for intended behavior
  - Produce a Markdown answer following the output format specification from the playbook
  - Save the test investigation result to `Auto Run Docs/Initiation/Working/test-investigation-hooks.md` with YAML front matter:
    - type: report, title: "Test Investigation: Hook Lifecycle System", tags: [validation, hooks, test]
  - After saving, review the result against the playbook's output format spec and note any gaps or improvements needed
  - If improvements are identified, update `skills/documentator/SKILL.md` to address them
