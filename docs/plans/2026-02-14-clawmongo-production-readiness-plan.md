# ClawMongo Production Readiness Plan

> **For Claude:** REQUIRED: Follow this plan phase-by-phase. Each phase has clear exit criteria.
> **Design:** See `CLAWMONGO_FRESH_START.md` for full specification.
> **Research:** See `docs/research/2026-02-14-mongodb-capabilities-atlas-vs-community.md`

**Goal:** Prepare ClawMongo (MongoDB memory backend for OpenClaw) for production: commit, sync with upstream (156 commits behind), add DX improvements, documentation, CI integration, and prepare PR(s) for upstream contribution.

**Architecture:** ClawMongo adds MongoDB as a 3rd memory backend alongside SQLite ("builtin") and QMD. It implements the `MemorySearchManager` interface with 4 new source files (1,794 LOC) and modifies 4 existing files (+211 lines). A 6-stage search cascade handles all MongoDB deployment profiles from Atlas to Community bare.

**Tech Stack:** TypeScript, MongoDB driver, chokidar, vitest, pnpm, GitHub Actions

**Prerequisites:**

- Feature-complete implementation (175 unit + 21 E2E tests, TSC clean)
- Fork at github.com/romiluz13/ClawMongo, upstream at github.com/openclaw/openclaw
- All changes currently uncommitted (untracked + modified in working tree)

---

## Relevant Codebase Files

### Our MongoDB Files (New - 4 files, 1,794 LOC)

- `src/memory/mongodb-manager.ts` (535 lines) - Main manager class, implements MemorySearchManager
- `src/memory/mongodb-schema.ts` (330 lines) - Collection helpers, index management, capabilities detection
- `src/memory/mongodb-search.ts` (540 lines) - 6-stage search cascade, vector/keyword/hybrid search
- `src/memory/mongodb-sync.ts` (389 lines) - File watcher sync, hash-based skip, session syncing

### Our Test Files (5 files, 2,530 LOC)

- `src/memory/mongodb-schema.test.ts` (386 lines)
- `src/memory/mongodb-search.test.ts` (475 lines)
- `src/memory/mongodb-sync.test.ts` (597 lines)
- `src/memory/mongodb-watcher.test.ts` (422 lines)
- `src/memory/mongodb-e2e.e2e.test.ts` (650 lines) - E2E tests requiring Docker MongoDB

### Modified OpenClaw Files (4 files, +211 lines)

- `src/config/types.memory.ts` (+32 lines) - MemoryBackend union, MemoryMongoDBConfig type
- `src/memory/types.ts` (+2 lines, -2 lines) - "mongodb" added to MemoryProviderStatus backend union
- `src/memory/backend-config.ts` (+45 lines) - ResolvedMongoDBConfig type, mongodb branch in resolveMemoryBackendConfig()
- `src/memory/search-manager.ts` (+31 lines) - MongoDB import, cache, factory branch with fallback

### DX Integration Points (Existing OpenClaw files to modify)

- `src/wizard/onboarding.ts` (484 lines) - Main wizard; NO memory section currently
- `src/commands/configure.shared.ts` (77 lines) - 8 configure sections; NO memory section
- `src/commands/doctor.ts` (316 lines) - Doctor command; calls `noteMemorySearchHealth()` at line 263
- `src/commands/doctor-memory-search.ts` (140 lines) - Memory health check; builtin/QMD only
- `docs/concepts/memory.md` (564 lines) - Memory documentation; NO MongoDB section

### CI/CD Files

- `.github/workflows/ci.yml` - Main CI; uses `pnpm test` (vitest), no MongoDB service
- `CONTRIBUTING.md` (upstream) - Requires `pnpm build && pnpm check && pnpm test`, single-concern PRs

### Configuration Files

- `package.json` (+2 lines - mongodb driver dependency)
- `pnpm-lock.yaml` (+357 lines)

---

## Phase 0: Git Foundation & Upstream Sync (HIGHEST PRIORITY)

> **Exit Criteria:** All ClawMongo work committed on a feature branch, upstream merged, conflicts resolved, all tests passing.
> **Risk Level:** HIGH - 156 commits to merge, 4 files with potential conflicts
> **Estimated Time:** 2-4 hours

### Why This Must Be First

Every other phase depends on a clean git state. Currently:

- All ClawMongo work is UNCOMMITTED (untracked + modified files)
- Fork is 156 commits behind upstream (was 133, growing daily)
- No `upstream` remote configured
- Upstream has actively modified ALL 4 of our modified files (QMD features, lint fixes, resilience hardening)

### Task 0.1: Create Feature Branch and Initial Commit

**Files:** All new and modified files

**Step 1:** Create feature branch from current state

```bash
cd /Users/rom.iluz/Dev/ClawMongo-v2
git checkout -b feat/mongodb-memory-backend
```

**Step 2:** Stage and commit new MongoDB source files (unmodified OpenClaw files)

```bash
git add src/memory/mongodb-manager.ts \
        src/memory/mongodb-schema.ts \
        src/memory/mongodb-search.ts \
        src/memory/mongodb-sync.ts
git commit -m "feat(memory): add MongoDB memory backend implementation

Add 4 new source files implementing MemorySearchManager interface:
- mongodb-manager.ts: Main manager with file watcher (chokidar)
- mongodb-schema.ts: Collection helpers, indexes, capability detection
- mongodb-search.ts: 6-stage search cascade (scoreFusion/rankFusion/JS/vector/keyword/text)
- mongodb-sync.ts: File sync with hash-based skip, session syncing

Supports 4 deployment profiles: atlas-default, atlas-m0, community-mongot, community-bare
Supports 2 embedding modes: automated (Voyage AI autoEmbed), managed (external vectors)"
```

**Step 3:** Stage and commit test files

```bash
git add src/memory/mongodb-schema.test.ts \
        src/memory/mongodb-search.test.ts \
        src/memory/mongodb-sync.test.ts \
        src/memory/mongodb-watcher.test.ts \
        src/memory/mongodb-e2e.e2e.test.ts
git commit -m "test(memory): add MongoDB backend tests (175 unit + 21 E2E)

Unit tests mock MongoDB driver, E2E tests run against Docker MongoDB 8.2.5.
Coverage: schema (indexes, capabilities, budget), search (cascade, fusion, automated mode),
sync (hash skip, force, sessions, stale cleanup), watcher (debounce, close order)."
```

**Step 4:** Stage and commit modified OpenClaw files

```bash
git add src/config/types.memory.ts \
        src/memory/types.ts \
        src/memory/backend-config.ts \
        src/memory/search-manager.ts \
        src/memory/backend-config.test.ts
git commit -m "feat(memory): wire MongoDB backend into OpenClaw config and factory

- types.memory.ts: Add MemoryMongoDBConfig, deployment profiles, fusion methods
- types.ts: Add 'mongodb' to MemoryProviderStatus.backend union
- backend-config.ts: Add ResolvedMongoDBConfig, mongodb branch in resolveMemoryBackendConfig()
- search-manager.ts: Add MongoDB dynamic import, cache, factory branch with fallback
- backend-config.test.ts: Add MongoDB config resolution tests"
```

**Step 5:** Stage and commit dependency changes

```bash
git add package.json pnpm-lock.yaml
git commit -m "chore: add mongodb driver dependency"
```

**Step 6:** Stage and commit documentation/planning files

```bash
git add CLAWMONGO_FRESH_START.md docs/plans/ docs/research/
git commit -m "docs: add MongoDB backend design docs and research

- CLAWMONGO_FRESH_START.md: Design document with deployment profiles and search cascade
- docs/plans/: Implementation and production readiness plans
- docs/research/: MongoDB capabilities research (Atlas vs Community, Feb 2026)"
```

**Step 7:** Verify clean state

```bash
git status
# Should show only .claude/ as untracked (memory files, not for commit)
```

**Step 8:** Run full test suite to confirm

Run: `pnpm test`
Expected: All existing + new tests pass

### Task 0.2: Add Upstream Remote and Fetch

**Step 1:** Add upstream remote

```bash
git remote add upstream https://github.com/openclaw/openclaw.git
```

**Step 2:** Fetch upstream

```bash
git fetch upstream main
```

**Step 3:** Check divergence

```bash
git log --oneline HEAD..upstream/main | wc -l
# Expected: ~156 commits
```

### Task 0.3: Merge Upstream Into Feature Branch

**Step 1:** Merge upstream/main into feature branch

```bash
git merge upstream/main --no-edit
```

**Step 2:** If conflicts, resolve them for these specific files:

**Conflict Resolution Strategy (file by file):**

| File                                | Upstream Changes                                                         | Our Changes                                                       | Resolution Strategy                                                                                                                                             |
| ----------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/config/types.memory.ts`        | QMD searchMode, hardened types                                           | Added MemoryMongoDBConfig                                         | BOTH: Keep upstream QMD changes + our MongoDB types. They're additive (different sections).                                                                     |
| `src/memory/types.ts`               | Minor type changes                                                       | Changed `"builtin" \| "qmd"` to `"builtin" \| "qmd" \| "mongodb"` | BOTH: Keep upstream + add "mongodb" to union.                                                                                                                   |
| `src/memory/backend-config.ts`      | QMD searchMode, command parsing, session config, timeout config          | Added MongoDB branch + ResolvedMongoDBConfig                      | BOTH: Keep ALL upstream QMD improvements + our MongoDB section. Our MongoDB code is a new `if (backend === "mongodb")` block before the QMD block - no overlap. |
| `src/memory/search-manager.ts`      | FallbackMemoryManager improvements, cache eviction, idempotent callbacks | Added MongoDB import/cache/factory branch                         | BOTH: Keep ALL upstream FallbackMemoryManager improvements + our MongoDB block. Our code is a new block at lines 26-47 - may shift but logic is independent.    |
| `package.json`                      | Various dependency updates                                               | Added mongodb driver                                              | BOTH: Keep upstream deps + our mongodb addition.                                                                                                                |
| `pnpm-lock.yaml`                    | Many changes                                                             | mongodb driver resolution                                         | REGENERATE: After resolving package.json, run `pnpm install` to regenerate.                                                                                     |
| `src/memory/backend-config.test.ts` | Possible new QMD tests                                                   | Added MongoDB config tests                                        | BOTH: Keep all upstream tests + our MongoDB tests.                                                                                                              |

**Step 3:** After resolving conflicts, regenerate lockfile

```bash
pnpm install
```

**Step 4:** Run full test suite

Run: `pnpm build && pnpm check && pnpm test`
Expected: ALL tests pass (existing + ours)

**Step 5:** Commit merge resolution

```bash
git add -A
git commit -m "merge: sync with upstream openclaw/openclaw main

Resolved conflicts in 4 modified files. All changes are additive:
MongoDB backend code occupies independent code paths from QMD improvements."
```

### Task 0.4: Push Feature Branch

**Step 1:** Push feature branch to origin (our fork)

```bash
git push -u origin feat/mongodb-memory-backend
```

**Step 2:** Verify on GitHub

```bash
gh pr list --repo romiluz13/ClawMongo
```

---

## Phase 1: DX Improvements (HIGH PRIORITY)

> **Exit Criteria:** Users can discover, configure, and validate MongoDB backend through the standard OpenClaw CLI workflow.
> **Risk Level:** MEDIUM - modifying existing wizard/doctor code
> **Estimated Time:** 6-10 hours
> **Depends on:** Phase 0 (clean git state)

### Task 1.1: Add Memory Backend Selection to Onboarding Wizard

**Files:**

- Modify: `src/wizard/onboarding.ts` (insert between skills setup and finalization, around line 463)
- Create: `src/wizard/onboarding-memory.ts` (new file for memory setup logic)
- Modify: `src/commands/onboard-types.ts` (add memory-related options)

**Context:** The onboarding wizard flow is:

1. Security warning (line 47-88)
2. Mode selection: quickstart/advanced (line 140-147)
3. Config handling: keep/modify/reset (line 157-188)
4. Gateway config: port, bind, auth, tailscale (line 190-292)
5. Auth choice: API key provider (line 370-419)
6. Model selection (line 404-419)
7. Gateway finalization (line 423-432)
8. Channels setup (line 435-451)
9. Skills setup (line 459-463)
10. Hooks setup (line 466)
11. **<-- INSERT MEMORY BACKEND SELECTION HERE -->**
12. Finalization (line 468-483)

**Design:** Memory backend selection should be OPTIONAL and non-blocking. In quickstart mode, skip it entirely (default to builtin). In advanced mode, offer the choice.

**Step 1:** Create `src/wizard/onboarding-memory.ts`

```typescript
import type { OpenClawConfig } from "../config/config.js";
import type { WizardPrompter } from "./prompts.js";

/**
 * Interactive memory backend selection for the onboarding wizard.
 * Returns updated config with memory backend settings.
 */
export async function setupMemoryBackend(
  config: OpenClawConfig,
  prompter: WizardPrompter,
): Promise<OpenClawConfig> {
  const backend = await prompter.select({
    message: "Memory backend",
    options: [
      {
        value: "builtin",
        label: "Built-in (SQLite)",
        hint: "Default. Works everywhere, no setup needed.",
      },
      {
        value: "mongodb",
        label: "MongoDB",
        hint: "Scalable. Requires MongoDB 8.0+ connection.",
      },
      {
        value: "qmd",
        label: "QMD",
        hint: "Advanced. Local semantic search with qmd binary.",
      },
    ],
    initialValue: config.memory?.backend ?? "builtin",
  });

  if (backend === "builtin") {
    return config;
  }

  if (backend === "mongodb") {
    return await setupMongoDBMemory(config, prompter);
  }

  // QMD - no changes needed here, existing QMD setup handles it
  return {
    ...config,
    memory: { ...config.memory, backend: "qmd" },
  };
}

async function setupMongoDBMemory(
  config: OpenClawConfig,
  prompter: WizardPrompter,
): Promise<OpenClawConfig> {
  const uri = await prompter.text({
    message: "MongoDB connection URI",
    placeholder: "mongodb+srv://user:pass@cluster.mongodb.net/",
    validate: (value) => {
      const trimmed = value.trim();
      if (!trimmed) return "URI is required for MongoDB backend";
      if (!trimmed.startsWith("mongodb://") && !trimmed.startsWith("mongodb+srv://")) {
        return "URI must start with mongodb:// or mongodb+srv://";
      }
      return undefined;
    },
  });

  // Auto-detect deployment profile based on URI
  const trimmedUri = uri.trim();
  const isAtlas = trimmedUri.includes(".mongodb.net");
  const suggestedProfile = isAtlas ? "atlas-default" : "community-mongot";

  const profile = await prompter.select({
    message: "Deployment profile",
    options: [
      {
        value: "atlas-default",
        label: "Atlas (standard)",
        hint: "Full Atlas Search + Vector Search",
      },
      {
        value: "atlas-m0",
        label: "Atlas (free tier M0)",
        hint: "Limited to 3 search indexes total",
      },
      {
        value: "community-mongot",
        label: "Community + mongot",
        hint: "Self-hosted with mongot search engine",
      },
      {
        value: "community-bare",
        label: "Community (bare)",
        hint: "No mongot. Keyword search via $text only",
      },
    ],
    initialValue: suggestedProfile,
  });

  return {
    ...config,
    memory: {
      ...config.memory,
      backend: "mongodb",
      mongodb: {
        ...config.memory?.mongodb,
        uri: trimmedUri,
        deploymentProfile: profile,
      },
    },
  };
}
```

**Step 2:** Wire into onboarding wizard

In `src/wizard/onboarding.ts`, after skills setup (around line 466), add:

```typescript
import { setupMemoryBackend } from "./onboarding-memory.js";

// After: nextConfig = await setupInternalHooks(nextConfig, runtime, prompter);
// Before: nextConfig = applyWizardMetadata(...)

if (flow === "advanced") {
  nextConfig = await setupMemoryBackend(nextConfig, prompter);
}
```

**Step 3:** Write tests for onboarding-memory

Create `src/wizard/onboarding-memory.test.ts`:

- Test: builtin selection returns config unchanged
- Test: mongodb selection prompts for URI and profile
- Test: URI validation rejects empty and invalid URIs
- Test: Atlas URI auto-suggests atlas-default profile
- Test: non-Atlas URI auto-suggests community-mongot profile

**Step 4:** Run tests

Run: `pnpm test src/wizard/onboarding-memory.test.ts`
Expected: PASS

**Step 5:** Commit

```bash
git add src/wizard/onboarding-memory.ts src/wizard/onboarding-memory.test.ts src/wizard/onboarding.ts
git commit -m "feat(wizard): add memory backend selection to onboarding

Advanced mode now asks users to choose between builtin (SQLite), MongoDB,
or QMD memory backends. MongoDB selection prompts for URI and auto-detects
deployment profile. Quickstart mode skips this (defaults to builtin)."
```

### Task 1.2: Add Memory Section to Configure Wizard

**Files:**

- Modify: `src/commands/configure.shared.ts` (add "memory" to CONFIGURE_WIZARD_SECTIONS)
- Create: `src/commands/configure-memory.ts` (memory configure wizard)

**Step 1:** Add "memory" to the sections array in `configure.shared.ts`:

```typescript
export const CONFIGURE_WIZARD_SECTIONS = [
  "workspace",
  "model",
  "memory", // NEW
  "web",
  "gateway",
  "daemon",
  "channels",
  "skills",
  "health",
] as const;
```

Add to `CONFIGURE_SECTION_OPTIONS`:

```typescript
{ value: "memory", label: "Memory", hint: "Backend, MongoDB connection, search mode" },
```

**Step 2:** Create `src/commands/configure-memory.ts`

This should provide:

- Current memory backend display
- Backend selection (builtin/mongodb/qmd)
- If mongodb: URI, profile, fusion method, embedding mode
- Connection test (ping)
- Capability detection display

**Step 3:** Wire into configure command (find where sections are dispatched)

**Step 4:** Write tests, run, commit

```bash
git commit -m "feat(configure): add memory backend section to configure wizard

Users can now run 'openclaw configure' and select Memory to change
backend, set MongoDB URI, choose deployment profile, and test connection."
```

### Task 1.3: Add MongoDB Health Check to Doctor

**Files:**

- Modify: `src/commands/doctor-memory-search.ts` (add MongoDB-aware health check)
- Modify: `src/commands/doctor.ts` (ensure MongoDB check runs)

**Context:** `doctor-memory-search.ts` currently only checks embedding provider availability. It needs to also check:

- If backend=mongodb, is the URI set?
- Can we connect? (ping test with timeout)
- What capabilities are detected? (mongot, vector search, etc.)
- Is the deployment profile appropriate for the detected capabilities?

**Step 1:** Add MongoDB health check function to `doctor-memory-search.ts`

```typescript
async function noteMongoDBBackendHealth(cfg: OpenClawConfig): Promise<void> {
  const backendConfig = resolveMemoryBackendConfig({
    cfg,
    agentId: resolveDefaultAgentId(cfg),
  });

  if (backendConfig.backend !== "mongodb" || !backendConfig.mongodb) {
    return;
  }

  const { uri, deploymentProfile } = backendConfig.mongodb;
  if (!uri) {
    note(
      [
        "MongoDB memory backend is configured but no URI is set.",
        "",
        "Fix (pick one):",
        `- Set URI in config: ${formatCliCommand("openclaw config set memory.mongodb.uri mongodb+srv://...")}`,
        "- Set OPENCLAW_MONGODB_URI environment variable",
        `- Switch backend: ${formatCliCommand("openclaw config set memory.backend builtin")}`,
      ].join("\n"),
      "Memory (MongoDB)",
    );
    return;
  }

  // Connection test with timeout
  try {
    const { MongoClient } = await import("mongodb");
    const client = new MongoClient(uri, {
      serverSelectionTimeoutMS: 5000,
      connectTimeoutMS: 5000,
    });
    await client.connect();
    await client.db().command({ ping: 1 });
    await client.close();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    note(
      [
        `MongoDB connection failed: ${message}`,
        "",
        "Fix (pick one):",
        "- Check that MongoDB is running and accessible",
        "- Verify URI credentials and network access",
        `- Test manually: mongosh "${redactUri(uri)}"`,
        `- Switch backend: ${formatCliCommand("openclaw config set memory.backend builtin")}`,
      ].join("\n"),
      "Memory (MongoDB)",
    );
    return;
  }

  // Success - show status
  note(`MongoDB connected. Profile: ${deploymentProfile}.`, "Memory (MongoDB)");
}
```

**Step 2:** Call from `noteMemorySearchHealth` or alongside it in `doctor.ts`

**Step 3:** Write tests, run, commit

```bash
git commit -m "feat(doctor): add MongoDB backend health check

Doctor now validates MongoDB connection when backend=mongodb.
Shows connection status, deployment profile, and actionable fix
suggestions when connection fails."
```

### Task 1.4: Connection Validation with Actionable Errors

**Files:**

- Modify: `src/memory/backend-config.ts` (improve error message at line 282)
- Modify: `src/memory/mongodb-manager.ts` (improve connection error messages)

**Context:** Current error when no URI: `"MongoDB URI required: set memory.mongodb.uri in config or OPENCLAW_MONGODB_URI env var"`. This is decent but can be improved with specific commands.

**Step 1:** Enhance error messages throughout MongoDB manager to include:

- The specific `openclaw config set` command to fix the issue
- Common causes (network, auth, wrong URI format)
- Link to documentation

**Step 2:** Test error messages, commit

```bash
git commit -m "fix(memory): improve MongoDB error messages with actionable fix commands

Error messages now include specific CLI commands to resolve issues,
common causes, and links to documentation."
```

---

## Phase 2: Documentation (HIGH PRIORITY)

> **Exit Criteria:** docs/concepts/memory.md has a complete MongoDB section; example configs exist for all 4 deployment profiles.
> **Risk Level:** LOW - documentation only, no code changes
> **Estimated Time:** 3-5 hours
> **Depends on:** Phase 0 (for accurate content)

### Task 2.1: Add MongoDB Section to docs/concepts/memory.md

**Files:**

- Modify: `docs/concepts/memory.md` (add MongoDB section after QMD section)

**Content to add:**

````markdown
## MongoDB memory backend

MongoDB provides scalable, server-based memory with full-text search, vector search,
and hybrid retrieval. It requires MongoDB 8.0+ and supports four deployment profiles.

### Quick start

```json5
{
  memory: {
    backend: "mongodb",
    mongodb: {
      uri: "mongodb+srv://user:pass@cluster.mongodb.net/",
      deploymentProfile: "atlas-default",
    },
  },
}
```
````

Or via environment:

```bash
export OPENCLAW_MONGODB_URI="mongodb+srv://user:pass@cluster.mongodb.net/"
openclaw config set memory.backend mongodb
```

### Deployment profiles

| Profile            | When to use            | Search capabilities                    |
| ------------------ | ---------------------- | -------------------------------------- |
| `atlas-default`    | Atlas M10+             | Full: vector + keyword + hybrid fusion |
| `atlas-m0`         | Atlas free tier        | Full, but limited to 3 search indexes  |
| `community-mongot` | Self-hosted + mongot   | Full: vector + keyword + hybrid fusion |
| `community-bare`   | Self-hosted, no mongot | Keyword only ($text fallback)          |

### Search cascade

The MongoDB backend tries search methods in order of quality:

1. **$scoreFusion** (8.2+, needs mongot) - Normalized hybrid search
2. **$rankFusion** (8.0+, needs mongot) - Rank-based hybrid search
3. **JS merge** - Client-side merge of vector + keyword results
4. **Vector only** - $vectorSearch alone
5. **Keyword only** - $search with text operator
6. **$text fallback** - MongoDB built-in $text index (no mongot required)

### Configuration reference

| Key                                | Type   | Default                 | Description                                              |
| ---------------------------------- | ------ | ----------------------- | -------------------------------------------------------- |
| `memory.mongodb.uri`               | string | `$OPENCLAW_MONGODB_URI` | Connection string                                        |
| `memory.mongodb.database`          | string | `"openclaw"`            | Database name                                            |
| `memory.mongodb.collectionPrefix`  | string | `"openclaw_"`           | Collection name prefix                                   |
| `memory.mongodb.deploymentProfile` | string | `"atlas-default"`       | See profiles above                                       |
| `memory.mongodb.embeddingMode`     | string | `"automated"`           | `"automated"` (Voyage AI) or `"managed"`                 |
| `memory.mongodb.fusionMethod`      | string | `"scoreFusion"`         | Preferred: `"scoreFusion"`, `"rankFusion"`, `"js-merge"` |
| `memory.mongodb.quantization`      | string | `"none"`                | Vector quantization: `"none"`, `"scalar"`, `"binary"`    |
| `memory.mongodb.watchDebounceMs`   | number | `500`                   | File watcher debounce in ms                              |

````

**Step 1:** Add the MongoDB section to memory.md
**Step 2:** Review for accuracy against actual code
**Step 3:** Commit

```bash
git commit -m "docs(memory): add MongoDB backend section to memory.md

Documents deployment profiles, search cascade, configuration reference,
and quick-start examples for all 4 MongoDB deployment profiles."
````

### Task 2.2: Create Example Configuration Files

**Files:**

- Create: `docs/examples/memory-mongodb-atlas.json5`
- Create: `docs/examples/memory-mongodb-atlas-m0.json5`
- Create: `docs/examples/memory-mongodb-community-mongot.json5`
- Create: `docs/examples/memory-mongodb-community-bare.json5`

Each file should be a complete, copy-paste-ready OpenClaw config snippet with comments explaining each setting.

### Task 2.3: Create Troubleshooting Guide

**Files:**

- Create: `docs/guides/mongodb-troubleshooting.md`

**Content:**

- Connection issues (timeout, auth, network)
- Search not returning results (profile mismatch, missing mongot, index creation failed)
- Performance issues (missing indexes, large collections)
- Migration from builtin to MongoDB
- Common error messages and fixes

---

## Phase 3: CI/CD Integration (MEDIUM PRIORITY)

> **Exit Criteria:** MongoDB unit tests run in CI. E2E tests documented for manual/optional CI run.
> **Risk Level:** LOW-MEDIUM - CI config changes
> **Estimated Time:** 2-4 hours
> **Depends on:** Phase 0

### Task 3.1: Ensure MongoDB Unit Tests Run in CI

**Context:** The CI workflow (`.github/workflows/ci.yml`) runs `pnpm test` which executes vitest. Our unit tests (175) are already in the default vitest config and WILL run in CI automatically. The E2E tests (`mongodb-e2e.e2e.test.ts`) are excluded from the default vitest run (they require Docker MongoDB).

**Step 1:** Verify unit tests run with default vitest config

Run: `pnpm test -- --reporter=verbose 2>&1 | grep -c mongodb`
Expected: Shows mongodb test files being run

**Step 2:** Verify E2E tests are excluded

Run: `pnpm test 2>&1 | grep -c "e2e.test"`
Expected: 0 (e2e tests excluded)

This should "just work" because:

- Our unit tests use mocks, no real MongoDB needed
- E2E tests use `.e2e.test.ts` suffix which vitest is configured to exclude
- No CI changes needed for unit tests

### Task 3.2: Add Optional MongoDB E2E Test Job (Future)

**Context:** This is a SHOULD-HAVE for the PR but not blocking. The E2E tests need Docker MongoDB 8.2+.

**Design:** Add a separate CI job that:

1. Starts MongoDB 8.2 via Docker service
2. Runs only E2E tests
3. Is optional (not blocking for PRs)

```yaml
# Addition to .github/workflows/ci.yml
mongodb-e2e:
  needs: [docs-scope, changed-scope]
  if: needs.docs-scope.outputs.docs_only != 'true' && (github.event_name == 'push' || needs.changed-scope.outputs.run_node == 'true')
  runs-on: ubuntu-latest
  continue-on-error: true # Optional - don't block PRs
  services:
    mongodb:
      image: mongodb/mongodb-community-server:8.2-ubi9
      ports:
        - 27017:27017
  steps:
    - uses: actions/checkout@v4
    - uses: ./.github/actions/setup-node-env
    - run: pnpm test -- src/memory/mongodb-e2e.e2e.test.ts
      env:
        OPENCLAW_MONGODB_URI: mongodb://localhost:27017/
```

**Note:** This CI job should be proposed but NOT included in the initial PR to keep it focused. It can be a follow-up PR.

---

## Phase 4: PR Strategy (HIGH PRIORITY)

> **Exit Criteria:** PR(s) created on upstream with proper description, review guidance, and maintainer-friendly structure.
> **Risk Level:** MEDIUM - community acceptance
> **Estimated Time:** 2-3 hours
> **Depends on:** Phases 0-2 (Phase 3 is nice-to-have for PR)

### ADR: Single PR vs. Multiple PRs

**Context:** We have ~4,300 lines of new/modified code across 14 files. OpenClaw's CONTRIBUTING.md says "Keep pull requests focused on a single concern."

**Decision:** Use a STAGED PR APPROACH (2-3 PRs)

**Rationale:**

- A single 4,300-line PR is overwhelming for reviewers
- The core implementation (types + manager + search + sync + tests) is one logical unit
- DX improvements (wizard, doctor, configure) are a separate concern
- Documentation is a third concern

**PR Structure:**

### PR 1: Core MongoDB Backend (MAIN PR)

**Scope:**

- 4 new source files (1,794 LOC)
- 5 test files (2,530 LOC)
- 4 modified OpenClaw files (+211 lines)
- package.json + pnpm-lock.yaml

**Title:** `feat(memory): add MongoDB as 3rd memory backend`

**Description template:**

````markdown
## Summary

Adds MongoDB as a third memory backend option alongside SQLite ("builtin") and QMD.
This enables scalable, server-based memory with full-text search, vector search,
and hybrid retrieval for OpenClaw deployments.

### What's included

- **4 new source files** (1,794 LOC) implementing the `MemorySearchManager` interface
- **175 unit tests + 21 E2E tests**, all passing, TSC clean
- **4 deployment profiles**: Atlas, Atlas M0, Community + mongot, Community bare
- **6-stage search cascade**: $scoreFusion -> $rankFusion -> JS merge -> vector-only -> keyword-only -> $text fallback
- **File watcher** with chokidar (same pattern as builtin manager)
- **Zero breaking changes**: existing "builtin" and "qmd" backends unaffected

### Architecture

MongoDB backend is completely opt-in via `memory.backend: "mongodb"` in config.
If MongoDB is unavailable, the factory silently falls back to builtin (same
pattern as QMD fallback). All MongoDB code is lazily imported via dynamic
`import()` — zero cost when not used.

### Files changed

**New files:**

- `src/memory/mongodb-manager.ts` - Main manager class
- `src/memory/mongodb-schema.ts` - Collections, indexes, capability detection
- `src/memory/mongodb-search.ts` - Search cascade (vector + keyword + hybrid)
- `src/memory/mongodb-sync.ts` - File sync, hash-based dedup, session sync

**Modified files (minimal, additive):**

- `src/config/types.memory.ts` (+32 lines) - MongoDB config types
- `src/memory/types.ts` (+2 lines) - "mongodb" in backend union
- `src/memory/backend-config.ts` (+45 lines) - MongoDB config resolution
- `src/memory/search-manager.ts` (+31 lines) - MongoDB factory branch

### Testing

- 175 unit tests (vitest, mocked MongoDB driver)
- 21 E2E tests (Docker MongoDB 8.2.5 Community)
- All existing tests pass with zero regressions
- `pnpm build && pnpm check && pnpm test` passes

### How to try it

```bash
# Atlas
openclaw config set memory.backend mongodb
export OPENCLAW_MONGODB_URI="mongodb+srv://user:pass@cluster.mongodb.net/"

# Community (Docker)
docker run -d -p 27017:27017 mongodb/mongodb-community-server:8.2-ubi9
openclaw config set memory.backend mongodb
openclaw config set memory.mongodb.uri mongodb://localhost:27017/
openclaw config set memory.mongodb.deploymentProfile community-bare
```
````

### AI Disclosure

This implementation was developed with AI assistance (Claude). All code has been
reviewed, tested (175 unit + 21 E2E), and the developer understands every line.

````

### PR 2: MongoDB DX Improvements (Follow-up)

**Scope:** Onboarding wizard, configure wizard, doctor health check
**Depends on:** PR 1 merged
**Title:** `feat(wizard): add MongoDB memory backend to onboarding and configure`

### PR 3: MongoDB Documentation (Can be parallel)

**Scope:** docs/concepts/memory.md update, example configs, troubleshooting guide
**Title:** `docs(memory): add MongoDB backend documentation`

### Pre-PR Checklist

Before opening PR 1:

- [ ] `pnpm build` passes
- [ ] `pnpm check` passes (lint/format)
- [ ] `pnpm test` passes
- [ ] TSC clean (`pnpm tsc --noEmit`)
- [ ] No console.log debugging left
- [ ] MongoDB URI is never logged unredacted
- [ ] All new files have proper copyright/license headers (match existing)
- [ ] Commit history is clean and logical
- [ ] Branch is up to date with upstream/main

### Community Engagement Strategy

**Before opening PR:**
1. Open a GitHub Discussion on openclaw/openclaw: "Proposal: MongoDB as 3rd memory backend"
   - Explain motivation (scalability, vector search, existing MongoDB users)
   - Link to design doc
   - Ask for maintainer feedback on approach
2. Wait for initial response (1-2 weeks)
3. If positive/neutral, open PR 1

**Why Discussion first:** CONTRIBUTING.md explicitly says "New features/architecture: Start a GitHub Discussion or ask in Discord first." MongoDB backend is a new feature with architectural implications.

---

## Phase 5: Ongoing Maintenance Strategy (MEDIUM PRIORITY)

> **Exit Criteria:** Automated or documented process for keeping fork current with upstream.
> **Risk Level:** LOW - process/documentation only
> **Estimated Time:** 1-2 hours

### Task 5.1: Upstream Sync Script

**Files:**
- Create: `scripts/sync-upstream.sh`

```bash
#!/bin/bash
set -euo pipefail

echo "=== Syncing with upstream openclaw/openclaw ==="

# Ensure upstream remote exists
if ! git remote get-url upstream &>/dev/null; then
  echo "Adding upstream remote..."
  git remote add upstream https://github.com/openclaw/openclaw.git
fi

# Fetch upstream
echo "Fetching upstream..."
git fetch upstream main

# Show divergence
BEHIND=$(git rev-list --count HEAD..upstream/main)
AHEAD=$(git rev-list --count upstream/main..HEAD)
echo "Status: ${AHEAD} ahead, ${BEHIND} behind upstream/main"

if [ "$BEHIND" -eq 0 ]; then
  echo "Already up to date."
  exit 0
fi

echo ""
echo "Files with potential conflicts:"
git diff --name-only HEAD...upstream/main | grep -E "(types\.memory|backend-config|search-manager|types\.ts)" || echo "(none)"

echo ""
echo "To merge: git merge upstream/main"
echo "After merge: pnpm install && pnpm build && pnpm check && pnpm test"
````

### Task 5.2: GitHub Actions Upstream Sync Check (Optional)

**Design:** A weekly scheduled workflow that checks if fork is behind upstream and opens an issue.

```yaml
# .github/workflows/upstream-sync-check.yml
name: Upstream Sync Check
on:
  schedule:
    - cron: "0 9 * * 1" # Every Monday 9 AM UTC
  workflow_dispatch:

jobs:
  check-sync:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - run: |
          git remote add upstream https://github.com/openclaw/openclaw.git
          git fetch upstream main
          BEHIND=$(git rev-list --count HEAD..upstream/main)
          if [ "$BEHIND" -gt 0 ]; then
            echo "::warning::Fork is ${BEHIND} commits behind upstream"
          fi
```

### Task 5.3: Document Merge Conflict Hotspots

**Our 4 modified files and what upstream changes to watch for:**

| File                | Upstream Change Frequency     | Conflict Risk                         | What To Watch                           |
| ------------------- | ----------------------------- | ------------------------------------- | --------------------------------------- |
| `types.memory.ts`   | MEDIUM (QMD evolution)        | LOW (our types are additive)          | New memory config types                 |
| `types.ts`          | LOW (stable interface)        | LOW (one-line change)                 | MemoryProviderStatus changes            |
| `backend-config.ts` | HIGH (QMD active development) | LOW-MEDIUM (our block is independent) | New config resolution patterns          |
| `search-manager.ts` | HIGH (fallback improvements)  | LOW-MEDIUM (our block is independent) | FallbackMemoryManager interface changes |

**Key insight:** All our modifications are ADDITIVE. We add new `if (backend === "mongodb")` blocks that don't touch the existing builtin/QMD code paths. This makes conflicts resolvable by keeping BOTH sides.

### Task 5.4: Version Compatibility Matrix

| MongoDB Version        | Deployment Profile | Search Capabilities                 |
| ---------------------- | ------------------ | ----------------------------------- |
| 8.0 Community          | community-bare     | $text only                          |
| 8.0 Community + mongot | community-mongot   | $search, $vectorSearch, $rankFusion |
| 8.2 Community          | community-bare     | $text only                          |
| 8.2 Community + mongot | community-mongot   | Full (+ $scoreFusion)               |
| 8.0 Atlas M0           | atlas-m0           | Full (3 index limit)                |
| 8.0 Atlas M10+         | atlas-default      | Full                                |
| 8.2 Atlas M10+         | atlas-default      | Full (+ $scoreFusion)               |

---

## Risks

| Risk                                                | P (1-5) | I (1-5) | Score | Mitigation                                                                         |
| --------------------------------------------------- | ------- | ------- | ----- | ---------------------------------------------------------------------------------- |
| Upstream merge conflicts in 4 modified files        | 4       | 2       | 8     | All changes additive; independent code blocks. Resolve by keeping both sides.      |
| Upstream rejects MongoDB PR (architecture concern)  | 2       | 5       | 10    | Open Discussion FIRST. Start with core PR only. Be willing to iterate on design.   |
| Upstream changes MemorySearchManager interface      | 2       | 4       | 8     | Monitor upstream PRs. Interface has been stable. Our implementation is conformant. |
| MongoDB driver adds weight to OpenClaw install      | 3       | 2       | 6     | Dynamic import() means zero cost when not used. Document in PR.                    |
| E2E tests flaky in CI (Docker MongoDB)              | 3       | 2       | 6     | Mark E2E job as `continue-on-error: true`. Keep as separate job.                   |
| Fork falls further behind while waiting for review  | 4       | 3       | 12    | Sync script + weekly check. Rebase feature branch before PR.                       |
| Community bare profile provides poor search quality | 3       | 3       | 9     | Clearly document limitations. Auto-detect and warn. Recommend mongot.              |
| Automated embedding (Voyage AI) changes API         | 2       | 3       | 6     | Managed mode as fallback. Feature detection, not version detection.                |

---

## Success Criteria

- [ ] All ClawMongo work committed on feature branch
- [ ] Upstream merged, all tests passing
- [ ] Memory backend selectable in onboarding wizard (advanced mode)
- [ ] Memory section in configure wizard
- [ ] Doctor validates MongoDB connection
- [ ] docs/concepts/memory.md has MongoDB section
- [ ] Example configs for all 4 deployment profiles
- [ ] Pre-PR checklist complete
- [ ] Discussion opened on upstream repo
- [ ] PR 1 opened with proper description

---

## Execution Order Summary

```
Phase 0: Git Foundation (BLOCKING)
  0.1 Create branch + commit
  0.2 Add upstream remote
  0.3 Merge upstream (resolve conflicts)
  0.4 Push feature branch
    |
    v
Phase 1: DX (HIGH)          Phase 2: Docs (HIGH)         Phase 3: CI (MEDIUM)
  1.1 Onboard wizard           2.1 memory.md update          3.1 Verify unit tests
  1.2 Configure wizard         2.2 Example configs           3.2 E2E CI job (optional)
  1.3 Doctor health            2.3 Troubleshooting guide
  1.4 Error messages
    |                            |
    v                            v
Phase 4: PR Strategy (after 0-2)
  4.1 Open Discussion on upstream
  4.2 Wait for feedback
  4.3 Open PR 1 (core)
  4.4 Open PR 2 (DX) after PR 1 merges
  4.5 Open PR 3 (docs) in parallel
    |
    v
Phase 5: Maintenance (ongoing)
  5.1 Sync script
  5.2 Weekly sync check
  5.3 Monitor upstream changes
```

**Critical Path:** Phase 0 -> Phase 1 + Phase 2 (parallel) -> Phase 4
**Non-blocking:** Phase 3, Phase 5

---

## Implementation Notes

### What NOT to Change

- Do NOT change the default backend from "builtin" to "mongodb"
- Do NOT make MongoDB a required dependency
- Do NOT modify the MemorySearchManager interface
- Do NOT touch the builtin or QMD code paths
- Do NOT add MongoDB to quickstart flow (keep it advanced-only)

### Principles

- **Additive only:** All changes add new code paths, never modify existing ones
- **Zero cost when unused:** Dynamic imports, lazy initialization
- **Graceful degradation:** If MongoDB fails, fall back to builtin silently
- **Feature detection over version detection:** Use detectCapabilities(), not version checks
- **Match existing patterns:** Follow QMD's patterns for config, factory, fallback, tests
