# Bootstrap Report: Runbook Memory Subsystem

Date: 2026-03-31
Repo inspected: `/home/ebatter1/openclaw-upstream`

## Scope and assumptions

- OpenClaw code root is `/home/ebatter1/openclaw-upstream` (git root).
- Active runtime/config for your current OpenClaw deployment is driven from the live install under `/var/lib/openclaw/.openclaw/`, with staging artifacts under `/home/ebatter1/Documents/openclaw-safe-install/staging/` used as operator seed/reference files.
- This implementation will land in the repo first, with deployment wiring left as documented operator steps unless explicitly requested.

## 1) OpenClaw root structure

Top-level implementation surfaces in this repo:

- Core runtime and config: `src/`
- Bundled/local extensions: `extensions/`
- Built-in skills pack: `skills/`
- Agent skill overlays for repo-scoped work: `.agents/skills/`
- Docs: `docs/`
- Runtime build outputs: `dist/`, `dist-runtime/`

Evidence:

- Plugin/extension roots and structure are visible in repo tree (`extensions/*`) and plugin discovery code.
- Plugin source roots are resolved as stock/global/workspace in [`src/plugins/roots.ts`](/home/ebatter1/openclaw-upstream/src/plugins/roots.ts:16).

## 2) Existing tool/plugin integration points

OpenClaw plugin integration contract:

- Plugin manifest filename: `openclaw.plugin.json` with `id`, `configSchema`, optional `skills`, optional `contracts.tools` in [`src/plugins/manifest.ts`](/home/ebatter1/openclaw-upstream/src/plugins/manifest.ts:8).
- Plugin code registers tools through `api.registerTool(...)`; registry tracks names/factories in [`src/plugins/registry.ts`](/home/ebatter1/openclaw-upstream/src/plugins/registry.ts:278).
- Example modern extension pattern uses `definePluginEntry(...)` and direct tool registration in [`extensions/tavily/index.ts`](/home/ebatter1/openclaw-upstream/extensions/tavily/index.ts:6).
- Example manifest tool contract declaration in [`extensions/tavily/openclaw.plugin.json`](/home/ebatter1/openclaw-upstream/extensions/tavily/openclaw.plugin.json:19).
- Existing memory plugin demonstrates tool + CLI registration pattern in [`extensions/memory-core/index.ts`](/home/ebatter1/openclaw-upstream/extensions/memory-core/index.ts:21).

Runtime/plugin source roots:

- Stock/bundled plugins.
- Global plugins in `<configDir>/extensions`.
- Workspace plugins in `<workspace>/.openclaw/extensions`.
- Defined in [`src/plugins/roots.ts`](/home/ebatter1/openclaw-upstream/src/plugins/roots.ts:16).

Live deployment constraints observed in the staged config at bootstrap time:

- Tools are allowlisted (current allow list omits runbook tools) in [`openclaw.user-test.json`](/home/ebatter1/Documents/openclaw-safe-install/staging/openclaw.user-test.json:171).
- Plugin allowlist currently includes only `local-first-privacy`, `google-calendar-guarded`, `acpx` in [`openclaw.user-test.json`](/home/ebatter1/Documents/openclaw-safe-install/staging/openclaw.user-test.json:238).

Current live deployment note, updated 2026-04-22:

- `/var/lib/openclaw/.openclaw/openclaw.json` enables `runbook-memory` and allowlists `runbook_search`, `runbook_get`, `runbook_create`, `runbook_update`, `runbook_review_queue`, and `runbook_reindex`.

## 3) Existing skill format

Skill ingestion and structure:

- Skills are loaded from multiple roots with precedence: extra < bundled < managed < personal `.agents` < project `.agents` < workspace, in [`src/agents/skills/workspace.ts`](/home/ebatter1/openclaw-upstream/src/agents/skills/workspace.ts:446).
- Skill files are `SKILL.md`; front matter is optional but parsed when present via `parseFrontmatter(...)` in [`src/agents/skills/frontmatter.ts`](/home/ebatter1/openclaw-upstream/src/agents/skills/frontmatter.ts:23).
- OpenClaw-specific metadata in front matter is parsed under `metadata.openclaw` (requirements/install/env, etc.) in [`src/agents/skills/frontmatter.ts`](/home/ebatter1/openclaw-upstream/src/agents/skills/frontmatter.ts:186).
- Additional skill dirs can be injected via `skills.load.extraDirs` in config types in [`src/config/types.skills.ts`](/home/ebatter1/openclaw-upstream/src/config/types.skills.ts:10).

Bundle/plugin skill routing also exists:

- Codex/Claude/Cursor bundle manifests can expose `skills` directories via `.codex-plugin/plugin.json`, `.claude-plugin/plugin.json`, `.cursor-plugin/plugin.json` in [`src/plugins/bundle-manifest.ts`](/home/ebatter1/openclaw-upstream/src/plugins/bundle-manifest.ts:8).

## 4) Current runbook/document locations

Primary runbook corpus candidates found outside repo code:

- `/home/ebatter1/Documents/Memory Optimization runbook/` (full architecture/spec/prompts pack).
- `/home/ebatter1/Documents/OPENCLAW-*.md` operational docs (setup, routing, security, troubleshooting).
- `/home/ebatter1/Documents/openclaw-safe-install/*.md` operator/install docs, including the self-improving workspace wiring and the `~/self-improving/` tool-boundary canonicalization recorded in `README.md`.
- `/home/ebatter1/Documents/sunshine-runbook.md`.

Current custom extension/operator docs also in:

- `/home/ebatter1/Documents/openclaw-safe-install/staging/extensions/*`

Current formats:

- Mostly `.md`, plus some `.txt`/`.yaml` and JSON/JSONC config artifacts.
- No standardized runbook front matter schema currently enforced across the corpus.

## 5) Recommended insertion points for the new runbook memory subsystem

### A. Canonical content + memory backend

Create repo-root subsystem:

- `runbooks/` for canonical normalized runbooks.
- `runbook_memory/` for db/config/scripts/tools/tests/reports.

Rationale:

- Keeps operator-owned runbook memory under version control and near OpenClaw code.
- Aligns with bootstrap spec and avoids mutating source docs in `/Documents`.

### B. OpenClaw plugin integration

Add a new extension:

- `extensions/runbook-memory/`
- Manifest declares `contracts.tools` for:
  - `runbook_search`
  - `runbook_get`
  - `runbook_create`
  - `runbook_update`
  - `runbook_review_queue`
  - `runbook_reindex`

Rationale:

- Matches existing extension architecture (`definePluginEntry` + `api.registerTool`).
- Allows strict tool-level policy and audit through existing OpenClaw tool pipeline.

### C. Skill insertion

Add skill docs under plugin-local skills path:

- `extensions/runbook-memory/skills/author_runbook_from_change/SKILL.md`
- `extensions/runbook-memory/skills/answer_from_runbooks_first/SKILL.md`
- `extensions/runbook-memory/skills/maintenance_librarian/SKILL.md`

Rationale:

- Uses existing skill discovery from plugin manifests and workspace merge logic.

### D. Runtime config insertion

After code lands, update runtime config to enable/use subsystem:

- Add plugin to `plugins.allow` and `plugins.entries`.
- Add runbook tool names to `tools.allow` if allowlist mode is active.
- Optionally add plugin path via `plugins.load.paths` for non-bundled deploys.

Target config file candidates:

- `/home/ebatter1/Documents/openclaw-safe-install/staging/openclaw.user-test.json`
- `/home/ebatter1/Documents/openclaw-safe-install/staging/openclaw.json`

### E. Maintenance automation insertion

Add maintenance scripts and sample units:

- `runbook_memory/scripts/*`
- `runbook_memory/config/systemd/*.service` + `*.timer`

Rationale:

- Matches your existing systemd-oriented operational model in staging docs.

## 6) Implementation handoff checklist (from discovery)

- [x] OpenClaw root identified.
- [x] Plugin/tool loading conventions identified.
- [x] Skill format and precedence identified.
- [x] Existing runbook/doc corpus paths identified.
- [x] Config and policy insertion points identified.

## Non-blocking question

- Should I also patch your staged runtime config files in `/home/ebatter1/Documents/openclaw-safe-install/staging/` in this same pass, or keep this commit strictly repo-contained and leave deploy config updates documented?
