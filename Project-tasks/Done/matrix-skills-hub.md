# Matrix Skills Hub

> Local skill catalog sync + UI marketplace for ClawHub skills

**Related docs:**

- `Project-tasks/Done/matrix-tier3-subagents.md` — Tier 3 sub-agent plan (implemented)
- `Project-tasks/matrix-project-context-plan.md` — Project context flow
- `skills/clawhub/SKILL.md` — ClawHub CLI skill

---

## The Problem

ClawHub (clawhub.ai) is the official OpenClaw skill registry with 177+ skills. However:

| Issue                    | Impact                                            |
| ------------------------ | ------------------------------------------------- |
| **No GUI access**        | Can only browse via CLI (`clawhub explore`)       |
| **No filtering**         | Can't filter by category, popularity, owner, etc. |
| **No local cache**       | Every query hits the API                          |
| **Poor discoverability** | Hard to find relevant skills                      |

The goal: **Sync the ClawHub catalog locally** and expose it in ui-next as a **Skill Marketplace** with filtering, search, and one-click install.

---

## Research Findings

### ClawHub Stats (as of 2026-03-04)

| Metric                 | Value                                   |
| ---------------------- | --------------------------------------- |
| Total skills           | 177                                     |
| Top skill by downloads | gemini (17,290)                         |
| Top skill by installs  | summarize (1,432)                       |
| Auth required          | No (for read operations)                |
| API                    | CLI only, no public REST API documented |

### Category Distribution (Derived from Keywords)

| Category      | Count | Keywords                                          |
| ------------- | ----- | ------------------------------------------------- |
| Development   | 39    | github, git, code, deploy, api, cli, dev          |
| Productivity  | 21    | task, todo, schedule, briefing, plan, workflow    |
| Social        | 21    | twitter, telegram, discord, social, post, content |
| Automation    | 11    | automate, cron, schedule, trigger, monitor        |
| Media         | 8     | video, audio, image, youtube, music, transcribe   |
| Utility       | 8     | weather, search, summarize, translate, convert    |
| Communication | 7     | message, chat, email, notify, alert               |
| Data          | 7     | data, analytics, metrics, report, dashboard       |
| Finance       | 3     | crypto, trading, binance, stock, price            |

**Note:** ClawHub has no explicit `category` field. Categories are derived from tags and summary text.

### Skill Metadata Available

```json
{
  "slug": "weather",
  "displayName": "Weather",
  "summary": "Get current weather and forecasts...",
  "tags": { "latest": "1.0.0" },
  "stats": {
    "downloads": 54444,
    "installsAllTime": 1053,
    "installsCurrent": 1030,
    "stars": 189,
    "comments": 6,
    "versions": 1
  },
  "owner": {
    "handle": "steipete",
    "displayName": "Peter Steinberger",
    "image": "https://..."
  },
  "latestVersion": {
    "version": "1.0.0",
    "changelog": "...",
    "files": [{ "path": "SKILL.md", "size": 1169, "sha256": "..." }],
    "security": { "status": "clean", "hasWarnings": true }
  },
  "metadata": {
    "os": ["darwin", "linux", "win32"],
    "systems": null
  }
}
```

### Skill Preview

```bash
# ✅ VERIFIED (clawhub v0.5.0): --file <path> exists on inspect
clawhub inspect weather --file SKILL.md
# Also available: --json for metadata, --files to list all files, --versions for history
```

This enables **inline preview** in the marketplace.

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                ClawHub Registry (clawhub.ai)            │
│  - 177+ skills                                           │
│  - Access via CLI (no public REST API)                  │
└─────────────────────────────────────────────────────────┘
                           │
                           ▼  (sync: clawhub explore --limit 200 --json)
                           │  ✅ flags verified: clawhub v0.5.0, max limit 200
┌─────────────────────────────────────────────────────────┐
│              Local Catalog Cache                         │
│  <workspace>/.openclaw/clawhub/catalog.json             │
│  - All skill metadata + derived categories              │
│  - Stats snapshot + last sync timestamp                 │
│                                                         │
│  <workspace>/.openclaw/clawhub/previews/<slug>.json     │
│  - Cached SKILL.md content (fetched on demand)          │
└─────────────────────────────────────────────────────────┘
                           │
                           ▼  (read via gateway RPC)
┌─────────────────────────────────────────────────────────┐
│              ui-next Skill Marketplace                   │
│  - Browse all skills (new tab alongside existing Skills) │
│  - Filter by category, popularity, owner                 │
│  - Search (local text search)                            │
│  - View details + cached SKILL.md preview               │
│  - Install button → clawhub.download RPC                  │
└─────────────────────────────────────────────────────────┘
                           │
                           ▼  (install → shell: clawhub install <slug>)
┌─────────────────────────────────────────────────────────┐
│              Installed Skills                            │
│  <workspace>/skills/<slug>/                              │
│  - SKILL.md (loaded into agent context on NEXT restart) │
│  ⚠️  Not active until agent session is reloaded         │
└─────────────────────────────────────────────────────────┘
```

---

## Components

### 1. Catalog Sync Service

**Responsibility:** Fetch and cache ClawHub catalog locally.

**Location:** Gateway-executed; writes to Operator1 workspace state directory.

**Sync mechanism:**

```bash
# ✅ VERIFIED (clawhub v0.5.0): --json and --limit exist on explore
# ⚠️ Max --limit is 200 (not 500 as originally assumed). 177 skills fits within 200.
clawhub explore --limit 200 --json
```

**Sync triggers:**

- Manual: "Sync ClawHub" button in ui-next
- Periodic: Daily/weekly cron (optional)
- On-demand: When marketplace is opened and cache is stale (>24h)

**Catalog structure** (`<workspace>/.openclaw/clawhub/catalog.json`):

```json
{
  "syncedAt": "2026-03-04T00:00:00Z",
  "clawhubVersion": "1.x.x",
  "totalSkills": 177,
  "skills": [
    {
      "slug": "weather",
      "displayName": "Weather",
      "summary": "Get current weather and forecasts...",
      "category": "utility",
      "categories": ["utility"],
      "tags": { "latest": "1.0.0" },
      "stats": { "downloads": 54444, "installsAllTime": 1053, "stars": 189 },
      "owner": { "handle": "steipete", "displayName": "Peter Steinberger" },
      "latestVersion": { "version": "1.0.0", "changelog": "" },
      "metadata": { "os": null, "systems": null },
      "security": { "status": "clean", "hasWarnings": false }
    }
  ]
}
```

> `categories` is a multi-value array (a skill can belong to more than one), while `category` is the primary one for filtering. Both are derived at sync time.

**Category derivation:**

> ⚠️ **Gap:** The original single-pass first-match-wins logic is fragile — `"schedule"` appears in both `productivity` and `automation`; `"content"` is in `social` but matches too broadly. Replaced with a scored multi-category approach:

```javascript
function deriveCategories(skill) {
  const text = `${skill.summary} ${skill.displayName} ${skill.slug}`.toLowerCase();

  const categoryKeywords = {
    development: ["github", "git", "code", "deploy", "api", "cli", "dev", "pull request", "commit"],
    productivity: ["task", "todo", "briefing", "plan", "workflow", "reminder", "calendar"],
    social: ["twitter", "telegram", "discord", "social", "post", "mastodon", "bluesky"],
    automation: ["automate", "cron", "schedule", "trigger", "monitor", "webhook"],
    media: ["video", "audio", "image", "youtube", "music", "transcribe", "photo"],
    utility: ["weather", "search", "summarize", "translate", "convert", "calculate"],
    communication: ["message", "chat", "email", "notify", "alert", "sms"],
    data: ["data", "analytics", "metrics", "report", "dashboard", "database"],
    finance: ["crypto", "trading", "binance", "stock", "price", "market", "portfolio"],
  };

  // Score every category; collect all that score ≥ 1
  const scores = Object.entries(categoryKeywords).map(([cat, keywords]) => ({
    cat,
    score: keywords.filter((kw) => text.includes(kw)).length,
  }));

  const matched = scores.filter((s) => s.score > 0).sort((a, b) => b.score - a.score);
  const categories = matched.map((s) => s.cat);
  const primary = categories[0] ?? "other";
  return { category: primary, categories: categories.length ? categories : ["other"] };
}
```

---

### 2. Skill Marketplace UI (ui-next)

**Location:** ui-next dashboard → Skills tab

**Features:**

| Feature             | Description                                    |
| ------------------- | ---------------------------------------------- |
| **Browse**          | Grid/list view of all skills                   |
| **Filter**          | By category, popularity, owner, OS support     |
| **Search**          | Local text search on name, summary, tags       |
| **Sort**            | By downloads, stars, newest, trending          |
| **Preview**         | Inline SKILL.md content (fetched on-demand)    |
| **Install**         | One-click install via `clawhub install <slug>` |
| **Installed badge** | Show which skills are already installed        |

**UI mockup:**

```
┌─────────────────────────────────────────────────────────────┐
│  Skills Marketplace                        [Sync] [Filter]  │
├─────────────────────────────────────────────────────────────┤
│  Categories: [All] [Dev] [Prod] [Social] [Auto] [Media] ... │
│  Sort: [Popular ▼]  Search: [________________]              │
├─────────────────────────────────────────────────────────────┤
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐         │
│  │ 🌤️ Weather  │  │ 🐙 GitHub   │  │ 📝 Summarize│         │
│  │             │  │             │  │             │         │
│  │ Get weather │  │ gh CLI for  │  │ Extract key │         │
│  │ forecasts   │  │ issues/PRs  │  │ points      │         │
│  │             │  │             │  │             │         │
│  │ ⬇️ 54K  ⭐ 189│  │ ⬇️ 64K  ⭐ 214│  │ ⬇️ 70K  ⭐ 323│         │
│  │ [Installed] │  │ [Install]   │  │ [Install]   │         │
│  └─────────────┘  └─────────────┘  └─────────────┘         │
│                                                             │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐         │
│  │ 📱 Social   │  │ ✨ Gemini   │  │ 🎙️ Clawsaver│         │
│  │ Media Ops   │  │ AI routing  │  │ Batch msgs  │         │
│  │ ...         │  │ ...         │  │ ...         │         │
│  └─────────────┘  └─────────────┘  └─────────────┘         │
└─────────────────────────────────────────────────────────────┘
```

**Skill detail view:**

```
┌─────────────────────────────────────────────────────────────┐
│  ← Back to Marketplace                                       │
├─────────────────────────────────────────────────────────────┤
│  🌤️ Weather                                                 │
│  by steipete · v1.0.0 · utility                             │
│                                                             │
│  ⬇️ 54,444 downloads  ⭐ 189 stars  💬 6 comments           │
│                                                             │
│  Get current weather and forecasts (no API key required).   │
│                                                             │
│  ─────────────────────────────────────────────────────────  │
│  SKILL.md Preview                                           │
│  ─────────────────────────────────────────────────────────  │
│  ---                                                        │
│  name: weather                                              │
│  description: Get current weather and forecasts...          │
│  ---                                                        │
│                                                             │
│  # Weather Skill                                            │
│                                                             │
│  Two free services, no API keys needed.                     │
│                                                             │
│  ## wttr.in (primary)                                       │
│  ...                                                        │
│                                                             │
│  ─────────────────────────────────────────────────────────  │
│                                                             │
│  [Install Skill]                                            │
└─────────────────────────────────────────────────────────────┘
```

---

### 3. Install Flow

**Step 1:** User clicks "Install Skill" (or "Update" if already installed)

**Step 2:** UI calls `clawhub.download` gateway RPC, which resolves the target workspace dynamically:

```bash
# Gateway resolves workspaceDir via resolveAgentWorkspaceDir(cfg, agentId)
# ⚠️ Do NOT hardcode ~/dev/operator1/skills — use the gateway's own resolver
clawhub install <slug> --dir <resolvedWorkspaceDir>/skills
```

**Step 3:** UI shows a spinner. Progress is not streamed (RPC is request/response); the button shows a loading state until the RPC resolves. For long installs, a timeout of 120s is recommended.

**Step 4:** On success:

- Skill folder appears at `<workspace>/skills/<slug>/`
- Marketplace shows "Installed" badge
- ⚠️ **The skill is NOT active yet** — it will be loaded the next time the agent session starts. The UI must show: _"Skill installed. It will be active after the next session restart."_

**Step 5 (new):** `clawhub.download` also stores the preview to the preview cache so the detail view is available offline after install.

**Error handling:**

- If install fails, show the stderr output from the CLI in the UI
- If skill already installed, show "Update" instead of "Install"
- If `clawhub` binary is not found, show install instructions

**Security gate:**

- If `security.hasWarnings === true` or `security.status !== "clean"`, show a confirmation dialog before proceeding with install

---

### 4. Installed Skills View

**Location:** ui-next dashboard → Marketplace tab → "Installed" sub-filter (or a dedicated Installed panel)

**Features:**

- List of installed skills with versions
- Update all / update individual skills (`clawhub update <slug>`)
- ⚠️ **Uninstall is not yet designed** — `clawhub` CLI has no `uninstall` command; uninstall would require deleting the skill folder from disk and removing the lockfile entry manually. Needs research.
- View skill files (link to workspace file browser)

**Data source:**

- Primary: cross-reference `<workspace>/skills/` folder listing against the local catalog
- Version info: read `<workspace>/.openclaw/clawhub/clawhub.lock.json` (if clawhub produces one)
- ⚠️ Do NOT use `clawhub.installed` as a separate truth source — this conflicts with `skills.status` which also reads the workspace. One source of truth: the workspace folder + catalog cross-reference.

---

## Local Storage Design

### Why JSON Files, Not a Database

All existing OpenClaw state uses JSON files (`~/.openclaw/openclaw.json`, `workspace-state.json`, `exec-approvals.json`, etc.). A database (SQLite, etc.) would add a binary dependency, complicate portability, and is unnecessary at the scale of 177–500 skills. JSON files are:

- Inspectable with any text editor or `jq`
- Git-ignorable with a single `.gitignore` entry
- Consistent with every other OpenClaw data file
- Fast enough: 500-skill catalog is ~2–3 MB in memory

Vector search (semantic) is listed as a future enhancement — if that lands, it would warrant a dedicated store (e.g., LanceDB, which is already used in `extensions/memory-lancedb`). For now, plain text search over JSON is sufficient.

---

### Designated Storage Location

All Skills Hub data lives inside the **workspace state directory**, not globally in `~/.openclaw/`. This keeps it workspace-scoped and consistent with how OpenClaw already stores workspace state (`<workspace>/.openclaw/workspace-state.json`).

```
<workspace>/                          ← e.g. ~/dev/operator1/
  .openclaw/                          ← WORKSPACE_STATE_DIRNAME (existing convention)
    clawhub/                          ← NEW: all Skills Hub data
      catalog.json                    ← full synced catalog (skills + derived categories + stats)
      clawhub.lock.json               ← lockfile mirrored from clawhub CLI (versions of installed skills)
      previews/                       ← cached SKILL.md content, one JSON envelope per skill
        weather.json
        github.json
        summarize.json
        ...
  skills/                             ← installed skill folders (existing convention)
    weather/
      SKILL.md
    github/
      SKILL.md
```

**Resolution:** `workspaceDir` is always resolved via `resolveAgentWorkspaceDir(cfg, agentId)` in the gateway — never hardcoded. The Skills Hub path is derived as:

```typescript
const clawhubDir = path.join(workspaceDir, ".openclaw", "clawhub");
const catalogPath = path.join(clawhubDir, "catalog.json");
const previewsDir = path.join(clawhubDir, "previews");
const lockPath = path.join(clawhubDir, "clawhub.lock.json");
```

---

### File Descriptions

| File                   | Written by                             | Read by                               | Notes                                                                                         |
| ---------------------- | -------------------------------------- | ------------------------------------- | --------------------------------------------------------------------------------------------- |
| `catalog.json`         | `clawhub.sync` RPC                     | `clawhub.catalog` RPC, UI Marketplace | Full skill list + derived categories + stats                                                  |
| `clawhub.lock.json`    | `clawhub install/update` CLI           | `clawhub.installed` RPC               | Mirrors what `clawhub` CLI tracks; may not exist before first install                         |
| `previews/<slug>.json` | `clawhub.inspect` RPC (on first fetch) | `clawhub.inspect` RPC (cache hit)     | JSON envelope `{ slug, version, fetchedAt, content }`; invalidated on sync if version changes |

---

### Cache Invalidation

- **Catalog:** Considered stale after 24 hours (compare `catalog.json → syncedAt` against `Date.now()`). UI prompts user to sync if stale when marketplace opens.
- **Previews:** Invalidated per-skill when `catalog.json` shows a newer `latestVersion.version` than what was cached. Each preview is a `.json` envelope (not `.md`) so it can be parsed without a separate metadata sidecar:

```json
{
  "slug": "weather",
  "version": "1.0.0",
  "fetchedAt": "2026-03-04T00:00:00Z",
  "content": "# Weather Skill\n\nTwo free services, no API keys needed..."
}
```

The `content` field holds the raw SKILL.md text as a string. The UI renders it as Markdown client-side.

---

## API Design (Gateway RPCs)

### `clawhub.sync`

Sync the ClawHub catalog locally. Writes to `<workspace>/.openclaw/clawhub/catalog.json`.

> ⚠️ **Prerequisite:** verify `clawhub explore --json` or equivalent flag exists before implementing.

```json
{
  "jsonrpc": "2.0",
  "method": "clawhub.sync",
  "params": { "force": false, "agentId": "operator1" },
  "id": 1
}
```

**Response:**

```json
{
  "result": {
    "syncedAt": "2026-03-04T00:00:00Z",
    "catalogPath": "/Users/rohits/dev/operator1/.openclaw/clawhub/catalog.json",
    "totalSkills": 177,
    "newSkills": 5,
    "updatedSkills": 12,
    "stalePreviewsInvalidated": 3
  }
}
```

### `clawhub.catalog`

Get the local catalog from `catalog.json` — no network call. Returns empty result with `stale: true` if catalog doesn't exist yet.

```json
{
  "jsonrpc": "2.0",
  "method": "clawhub.catalog",
  "params": {
    "agentId": "operator1",
    "category": "utility",
    "sort": "downloads",
    "search": "weather"
  },
  "id": 1
}
```

**Response:**

```json
{
  "result": {
    "syncedAt": "2026-03-04T00:00:00Z",
    "stale": false,
    "total": 177,
    "filtered": 3,
    "skills": ["..."]
  }
}
```

### `clawhub.inspect`

Fetch skill details + SKILL.md preview. Checks preview cache first (`previews/<slug>.json`); only calls out to `clawhub inspect` CLI if cache is missing or version has changed.

> ⚠️ **Prerequisite:** verify `clawhub inspect <slug> --file SKILL.md` flag exists in your installed version.

```json
{
  "jsonrpc": "2.0",
  "method": "clawhub.inspect",
  "params": { "agentId": "operator1", "slug": "weather", "includeFile": "SKILL.md" },
  "id": 1
}
```

### `clawhub.download`

Download a skill folder from the registry into `<workspace>/skills/<slug>/`. Named `download` (not `install`) to clearly distinguish it from `skills.install`, which installs _tool dependencies_ for skills already in the workspace — an entirely different operation.

> ⚠️ After a successful download the skill is **not active** in the current session. The response must include `requiresRestart: true` so the UI can inform the user.

```json
{
  "jsonrpc": "2.0",
  "method": "clawhub.download",
  "params": { "agentId": "operator1", "slug": "weather" },
  "id": 1
}
```

**Response:**

```json
{
  "result": {
    "ok": true,
    "slug": "weather",
    "installedAt": "<workspace>/skills/weather",
    "requiresRestart": true,
    "message": "Skill installed. It will be active after the next session restart."
  }
}
```

### `clawhub.installed`

List skills installed via clawhub. Cross-references `<workspace>/skills/` folder listing with the local catalog for metadata, and reads `<workspace>/.openclaw/clawhub/clawhub.lock.json` directly for version data. `clawhub list` is **not** shelled out to — it has no `--json` flag (verified v0.5.0).

```json
{
  "jsonrpc": "2.0",
  "method": "clawhub.installed",
  "params": { "agentId": "operator1" },
  "id": 1
}
```

---

## Known Gaps & Issues

Captured during design review (2026-03-04). Severity: 🔴 Critical (will break) · 🟠 Design gap · 🟡 Quality risk.

### 🔴 Critical

**G1 — Unverified CLI flags** ✅ Resolved (verified against clawhub v0.5.0)

- `clawhub explore --json` ✅ exists. `--limit` max is **200** (not 500 as assumed) — 177 skills fits within this.
- `clawhub inspect <slug> --file <path>` ✅ exists. Also supports `--json`, `--files`, `--versions`.
- `clawhub list` ⚠️ has **no `--json` flag** — cannot be shelled out to for structured data. The `clawhub.installed` RPC must read the lockfile directly instead of shelling to `clawhub list`.
- Sync command updated: `clawhub explore --limit 200 --json`.

**G2 — `clawhub.install` vs `skills.install` semantic conflict** ✅ Resolved
The existing `skills.install` RPC (in `src/gateway/server-methods/skills.ts`) installs _tool dependencies_ for skills already in the workspace. The new RPC _downloads a skill folder_ from the registry — a fundamentally different operation. **Resolution:** renamed to `clawhub.download` per operator1 agent review. Names are now unambiguous: `clawhub.download` = get the skill; `skills.install` = install the skill's tool deps.

**G3 — Skills are not active immediately after install**
The original plan claimed "Skill is immediately available to Operator1." This is false — skills are loaded at session start (`src/agents/workspace.ts`). The install RPC response must include `requiresRestart: true` and the UI must show a clear notice. See updated install flow above.

**G4 — Hardcoded install path**
The original plan used `~/dev/operator1/skills` as the install target — hardcoded to one machine. The gateway must resolve the path via `resolveAgentWorkspaceDir(cfg, agentId)` (already used in `src/gateway/server-methods/skills.ts`).

### 🟠 Design Gaps

**G5 — No uninstall mechanism defined** ✅ Research complete
`clawhub` CLI v0.5.0 has **no `uninstall` command** (confirmed via `clawhub --help`). **Resolution:** uninstall = gateway deletes `<workspace>/skills/<slug>/` from disk + removes the entry from `<workspace>/.openclaw/clawhub/clawhub.lock.json`. Needs a `clawhub.uninstall` RPC added to the API design (not yet defined). Add as Step 6a in the implementation order.

**G6 — Two sources of truth for installed skills** ✅ Further resolved
`clawhub list` has no `--json` flag (verified v0.5.0) — it cannot be used as a data source at all. The `clawhub.installed` RPC must read `clawhub.lock.json` directly from disk for version data, cross-referenced with the `<workspace>/skills/` folder listing. This is now the only approach.

**G7 — No streaming for install progress**
Gateway RPCs are request/response — no streaming. Long installs will show a frozen spinner. Mitigation: 120s timeout + loading state on the button. Future: investigate WebSocket progress events.

**G8 — Marketplace UI placement unspecified**
"ui-next dashboard → Skills tab" conflicts with the already-existing Skills tab (`ui-next/src/pages/skills.tsx`). Must decide: new top-level route (`/marketplace`), or a sub-tab within the existing Skills page. Must be resolved before building any UI.

**G9 — No `agentId` in original RPC params**
In a multi-agent Matrix setup, the marketplace must know which agent's workspace to use for sync, catalog reads, and install. All five RPCs now include `agentId` as a param; the gateway resolves workspace from it via `resolveAgentWorkspaceDir`.

### 🟡 Quality Risks

**G10 — Category derivation was first-match-wins with overlapping keywords**
`"schedule"` appeared in both `productivity` and `automation`; `"content"` matched `social` too broadly. Replaced with a scored multi-category approach that assigns all matching categories ranked by keyword hit count (see updated derivation function above).

**G11 — No security warning surface**
Skills with `security.hasWarnings === true` or non-clean status are not flagged in the detail view or install flow. Added: security gate confirmation dialog before install + security badge in the detail view.

**G12 — No caching for SKILL.md previews**
Original plan fetched SKILL.md on every detail view open via `clawhub inspect`. Now: cached to `<workspace>/.openclaw/clawhub/previews/<slug>.json` as a structured envelope `{ slug, version, fetchedAt, content }` with version-based invalidation. `.json` (not `.md`) makes it parseable without a metadata sidecar.

**G13 — Stale-check UX not designed**
When the marketplace opens with a stale catalog, the UI should show a banner/prompt ("Last synced X hours ago — sync now?") rather than a blank screen or a silent auto-sync. The `clawhub.catalog` RPC returns `stale: true` to enable this.

---

## Implementation Order

| Step | What                                                                      | How                                                                                     | Status           |
| ---- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ---------------- |
| 0    | **Verify CLI flags** — `clawhub explore --json`, `clawhub inspect --file` | Run `clawhub --help` and `clawhub explore --help`; document exact flags before any code | ⬜ Blocker       |
| 1    | Create `<workspace>/.openclaw/clawhub/` directory structure               | Gateway path resolver utility                                                           | ⬜ Not started   |
| 2    | Add scored multi-category derivation to catalog                           | TypeScript function in gateway                                                          | ⬜ Not started   |
| 3    | Create `clawhub.sync` RPC                                                 | Gateway handler; writes `catalog.json`                                                  | ⬜ Not started   |
| 4    | Create `clawhub.catalog` RPC                                              | Read + filter `catalog.json`; return `stale` flag                                       | ⬜ Not started   |
| 5    | Create `clawhub.inspect` RPC                                              | Check preview cache first; shell out if miss                                            | ⬜ Not started   |
| 6    | Create `clawhub.download` RPC                                             | Wrap `clawhub install`; return `requiresRestart: true`                                  | ⬜ Not started   |
| 6a   | Create `clawhub.uninstall` RPC                                            | Delete `<workspace>/skills/<slug>/` + remove lockfile entry; no CLI equivalent          | ⬜ Not started   |
| 7    | Create `clawhub.installed` RPC                                            | Read lockfile directly + cross-ref `skills/` folder; no `clawhub list --json`           | ⬜ Not started   |
| 8    | Determine ui-next routing                                                 | New "Marketplace" route vs tab in existing Skills page                                  | ⬜ Design needed |
| 9    | Build marketplace UI (browse/filter/search)                               | ui-next component                                                                       | ⬜ Not started   |
| 10   | Build skill detail view + security badge                                  | ui-next component                                                                       | ⬜ Not started   |
| 11   | Build install flow with restart notice + security gate                    | ui-next + gateway RPC                                                                   | ⬜ Not started   |
| 12   | Build installed skills view                                               | ui-next component                                                                       | ⬜ Not started   |
| 13   | Research uninstall path                                                   | Check clawhub CLI; design folder-delete flow if needed                                  | ⬜ Not started   |

---

## Open Questions

| Question                             | Options                                            | Resolution / Status                                                                                                                                           |
| ------------------------------------ | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Where to store catalog?**          | `~/.openclaw/` global vs workspace-scoped          | ✅ **Resolved:** `<workspace>/.openclaw/clawhub/` — workspace-scoped, consistent with existing `workspace-state.json` pattern                                 |
| **Database vs JSON files?**          | SQLite / LanceDB vs flat JSON                      | ✅ **Resolved:** JSON files — consistent with all existing OpenClaw data; 500-skill catalog is ~2–3 MB; add LanceDB only when/if vector search is implemented |
| **Sync frequency?**                  | Manual only vs periodic                            | ✅ **Resolved:** Manual + stale check (>24h against `syncedAt`)                                                                                               |
| **Search implementation?**           | Text search vs vector search                       | ✅ Text search first; vector search is a future enhancement (see `extensions/memory-lancedb`)                                                                 |
| **Category customization?**          | Fixed taxonomy vs user-defined                     | Fixed for now; multi-category scoring replaces single-match                                                                                                   |
| **`clawhub explore` JSON flag?**     | Does `--json` exist on explore/search?             | ✅ **Resolved:** exists in v0.5.0; max `--limit` is 200 (not 500)                                                                                             |
| **`clawhub list` JSON output?**      | Can `clawhub list` be used for structured data?    | ✅ **Resolved:** no `--json` flag — read `clawhub.lock.json` directly                                                                                         |
| **Uninstall mechanism?**             | CLI command vs manual folder delete                | ✅ **Resolved:** no CLI uninstall in v0.5.0; gateway deletes folder + lockfile entry via new `clawhub.uninstall` RPC                                          |
| **RPC naming: install vs download?** | `clawhub.install` vs `clawhub.download`            | ✅ **Resolved:** `clawhub.download` — avoids collision with `skills.install` (per operator1 agent review)                                                     |
| **UI placement?**                    | New top-level route vs tab in existing Skills page | ⬜ **Unresolved — design needed before Step 8**                                                                                                               |
| **Skill update notifications?**      | None vs in-app                                     | Future enhancement                                                                                                                                            |

---

## Benefits

1. **Discoverability** — Browse 177+ skills in a visual marketplace
2. **Filtering** — Find skills by category, popularity, owner
3. **Preview** — Read SKILL.md before installing
4. **One-click install** — No CLI knowledge required
5. **Local cache** — Instant browsing, no API latency
6. **Sync control** — Manual or automatic refresh

---

## What This Is Not

- This is **not** a skill editor — editing happens locally in skill folders
- This is **not** a skill publisher — use `clawhub publish` CLI
- This is **not** a skill runner — skills are loaded by OpenClaw at session start
- This is **not** a version manager — one version per skill (latest by default)

---

## Future Enhancements

| Enhancement                     | Description                          |
| ------------------------------- | ------------------------------------ |
| **Vector search**               | Embed summaries for semantic search  |
| **Skill ratings**               | Allow users to rate/review skills    |
| **Skill dependencies**          | Show which skills depend on others   |
| **Skill templates**             | Create new skills from templates     |
| **Skill marketplace analytics** | Track install trends, popular skills |

---

_Created: 2026-03-04_
_Last reviewed: 2026-03-04 — gaps, storage design, operator1 agent review, and live CLI verification incorporated_
_Author: Operator1 (COO)_
