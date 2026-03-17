# VioDashboard Setup Wizard Design

## Status

Phase 4A complete (as of 2026-03-17). Phases 2 + 3 were complete as of 2026-03-16.

- `GET /api/setup/state` is implemented in `src/server/setupState.mjs`.
- `POST /api/setup/action` is implemented in `src/server/setupActions.mjs` (phase 4A).
- Read-only setup UI is available at `/setup.html` (linked from the dashboard System panel).
- The setup UI now exposes two action buttons: **Preview bootstrap** and **Reload wrapper**.
- Phase 4 (remaining install actions) and Phase 5 (module readiness expansion) remain future work.

---

This document defines the **first-version information architecture** for a VioDashboard migration / deployment setup wizard.

The immediate goal is **not** to build a full interactive installer yet. The immediate goal is to stabilize:

- the step model
- the setup state contract
- the first-version step list
- the read-only UI shape
- the API contract that future setup UI will consume

This keeps the wizard from growing as ad-hoc frontend conditionals.

---

## Problem

VioDashboard is increasingly machine-shaped.

It now depends on:

- machine-specific paths
- gitignored local config
- CLI availability (for example Claude)
- launchd install / reload state
- runtime verification beyond static code presence
- module-level readiness that will continue growing as more integrations are added

README guidance, bootstrap CLI, install-time warnings, and UI banners are useful, but they are still **distributed affordances**.

For migration and deployment, we need a single setup flow that answers:

1. what is missing
2. what is blocked
3. what can be done next
4. what counts as "fully ready"

---

## Design goals

### Primary goals

- make migration and deployment repeatable
- show a single source of truth for setup readiness
- reuse existing state sources and scripts where possible
- separate read-only detection from mutating actions
- keep machine-specific values in `config/local.mjs`
- avoid hidden writes or silent auto-fixes

### Non-goals for v1

- full in-browser config editing wizard
- automatic repair of all missing dependencies
- replacing CLI/bootstrap flows immediately
- bundling all future module settings into the first version

---

## Conceptual model

The setup wizard is modeled as two layers:

1. **setup-plan**
   - semi-static definition of steps, dependencies, and intended actions
2. **setup-state**
   - runtime evaluation of the current machine against that plan

The setup UI should render **setup-state**.
The server should own state aggregation.
The plan can live as code or a static structure in the server implementation.

---

## Step model

Each wizard step should support the following shape.

```json
{
  "id": "local-config",
  "title": "Local machine config",
  "description": "Generate or verify gitignored machine-local configuration.",
  "kind": "config",
  "dependsOn": [],
  "checks": ["has-local-config", "config-path-readable"],
  "actions": ["bootstrap-preview", "bootstrap-generate"],
  "successWhen": "has-local-config",
  "blocking": true
}
```

### Field meanings

- `id`
  - stable identifier for frontend rendering and later action routing
- `title`
  - short human-readable label
- `description`
  - what this step is for
- `kind`
  - one of:
    - `config`
    - `dependency`
    - `install`
    - `verification`
- `dependsOn`
  - step ids that should logically precede this one
- `checks`
  - internal check identifiers the backend uses to evaluate status
- `actions`
  - symbolic actions or recommended commands associated with the step
- `successWhen`
  - the condition that marks the step complete
- `blocking`
  - whether failure here should block later readiness

---

## Status model

Each evaluated step should use a small, stable status vocabulary.

### Allowed statuses

- `complete`
- `ready`
- `missing`
- `warning`
- `blocked`
- `error`

### Intended meanings

- `complete`
  - step requirement is satisfied
- `ready`
  - step has enough prerequisites to proceed, but an action is still expected
- `missing`
  - required state or resource is absent
- `warning`
  - usable, but risky / degraded / incomplete
- `blocked`
  - cannot proceed because dependencies or prerequisites are not met
- `error`
  - evaluation failed or system returned invalid state

---

## Setup state contract

Top-level response shape for the read-only wizard API.

```json
{
  "ok": true,
  "summary": {
    "status": "incomplete",
    "completed": 3,
    "total": 6,
    "blocking": 1
  },
  "steps": []
}
```

### Top-level fields

- `ok`
  - API-level success
- `summary.status`
  - overall setup state, for example:
    - `ready`
    - `incomplete`
    - `blocked`
    - `error`
- `summary.completed`
  - count of completed steps
- `summary.total`
  - total step count
- `summary.blocking`
  - number of blocking steps not yet complete
- `steps`
  - ordered list matching the setup plan

### Per-step state shape

```json
{
  "id": "local-config",
  "title": "Local machine config",
  "status": "missing",
  "blocking": true,
  "message": "config/local.mjs is missing.",
  "evidence": {
    "hasLocalConfig": false,
    "localConfigPath": "/.../config/local.mjs"
  },
  "recommendedActions": [
    {
      "id": "bootstrap-generate",
      "label": "Generate local config",
      "kind": "command",
      "command": "node scripts/bootstrap-local-config.mjs"
    },
    {
      "id": "bootstrap-preview",
      "label": "Preview detected values",
      "kind": "command",
      "command": "node scripts/bootstrap-local-config.mjs --print --yes"
    }
  ]
}
```

### Per-step fields

- `id`
- `title`
- `status`
- `blocking`
- `message`
  - concise explanation of current state
- `evidence`
  - machine-readable facts backing the status
- `recommendedActions`
  - actions the UI can show without inventing logic

---

## First-version step list

The first version should ship with six steps.

### 1. Local machine config

**Purpose**
- verify that gitignored local config exists and is loadable

**Kind**
- `config`

**Blocking**
- yes

**Checks**
- `config/local.mjs` exists
- local config is readable
- setup metadata from `/api/config.setup` is sane

**Example evidence**
- `hasLocalConfig`
- `localConfigPath`

**Recommended actions**
- bootstrap preview
- bootstrap generate

---

### 2. Core path sanity

**Purpose**
- verify key resolved paths are present and not obviously wrong

**Kind**
- `config`

**Blocking**
- yes

**Checks**
- `projectRoot`
- `openclawRepoRoot`
- `defaultClaudeCwd`
- `configPath`
- `claudeBin`

**Example evidence**
- resolved string values for each field
- path existence where applicable

**Recommended actions**
- review generated local config
- rerun bootstrap if values are wrong

---

### 3. Dependency checks

**Purpose**
- verify key binaries and files actually exist

**Kind**
- `dependency`

**Blocking**
- yes

**Checks**
- Claude CLI exists / is executable
- OpenClaw config path exists
- required directories are writable when relevant

**Example evidence**
- `claudeBinExists`
- `configPathExists`
- `claudeBin`

**Recommended actions**
- install missing binary
- fix path in local config
- rerun bootstrap

---

### 4. Launch / install readiness

**Purpose**
- verify the machine can install and run the launchd-managed dashboard flow

**Kind**
- `install`

**Blocking**
- partially; should be treated as blocking for migration completion

**Checks**
- launchd scripts exist
- LaunchAgents directory is writable
- install prerequisites are satisfied

**Example evidence**
- install script path
- LaunchAgents directory path
- prerequisite booleans

**Recommended actions**
- install in source mode
- install in runtime mode

---

### 5. Runtime activation

**Purpose**
- verify the service is actually reachable

**Kind**
- `verification`

**Blocking**
- yes

**Checks**
- `/` returns `200`
- `/styles.css` returns `200`
- `/api/config` returns `200`
- launchd state indicates running when installed

**Example evidence**
- status codes
- launchd summary
- expected root / mode if available

**Recommended actions**
- reload wrapper
- restart launchd job
- inspect logs

---

### 6. Functional verification

**Purpose**
- verify critical product paths beyond simple liveness

**Kind**
- `verification`

**Blocking**
- yes for migration acceptance

**Checks**
- gateway websocket connected
- Claude card state is sensible
- Claude cwd is correct
- key module readiness can be expanded over time

**Example evidence**
- gateway connected state
- Claude running / idle / error
- Claude cwd
- module-level readiness map

**Recommended actions**
- verify Claude
- verify gateway
- inspect module-specific failures

---

## Recommended action model

Recommended actions should be explicit and typed.

Suggested shape:

```json
{
  "id": "bootstrap-generate",
  "label": "Generate local config",
  "kind": "command",
  "command": "node scripts/bootstrap-local-config.mjs"
}
```

### `kind` values for v1

- `command`
- `link`
- `note`

V1 should avoid executing actions automatically from the browser. Rendering recommendations is enough.

Future versions can add actionable buttons once the setup-state contract is stable.

---

## Proposed API contract

### Endpoint

- `GET /api/setup/state`

### Responsibilities

The endpoint should:

- evaluate all first-version setup steps
- return ordered step state objects
- compute overall summary
- reuse existing sources where possible

### Existing sources to reuse

- `/api/config`-backed config state
- current config module exports in `src/config.mjs`
- Claude state helpers / `/api/claude/state`
- launchd install / reload / status knowledge already present in scripts
- existing service reachability checks

### Important constraint

The setup-state endpoint should be a **read-only aggregator**.

It should not:
- write `config/local.mjs`
- install launch agents
- reload services
- auto-repair missing dependencies

Those remain separate actions in later phases.

---

## Action layer (phase 4A)

### Endpoint

- `POST /api/setup/action`

### Request body

```json
{ "action": "setup-refresh" }
```

### Allowed actions

| `action`           | Description                                                           |
|--------------------|-----------------------------------------------------------------------|
| `setup-refresh`    | Re-evaluates and returns fresh setup state. No side effects.          |
| `bootstrap-preview`| Dry-runs the bootstrap script (`--print --yes`) and returns output.   |
| `wrapper-reload`   | Schedules a launchd reload of the wrapper service after responding.   |

### Response shape (success)

```json
{
  "ok": true,
  "action": "bootstrap-preview",
  "output": ["line1", "line2"],
  "state": { "...": "optional, returned for setup-refresh" }
}
```

For `wrapper-reload` the HTTP status is `202` and the response includes a `message` field. The service restarts approximately 120 ms after the response is sent.

### Response shape (error)

```json
{ "ok": false, "error": "Unknown action \"foo\". Allowed: ..." }
```

### Safety boundary

- No automatic writes to `config/local.mjs`.
- No install-source / install-runtime / bootstrap-generate actions in phase 4A.
- Unknown action IDs are rejected with HTTP 400.
- `bootstrap-preview` uses `--print --yes` (dry-run only, no file writes).

### Implementation

- Action dispatcher: `src/server/setupActions.mjs`
- Route wired in: `src/server.mjs` (after `/api/setup/state`)

---

## First-version UI shape

V1 should be a **read-only setup page or setup tab**, not a full action wizard.

### Recommended location

One of:

- `setup.html`
- a dedicated Setup tab inside the existing dashboard shell

### Recommended structure

1. **Summary header**
   - overall status
   - completed / total
   - blocking step count

2. **Ordered step list**
   - title
   - status badge
   - message
   - evidence block
   - recommended actions block

3. **Current next step**
   - a short panel highlighting the most important unresolved blocking item

### Why read-only first

This lets the system become:
- inspectable
- debuggable
- easy to evolve

before we add buttons that mutate the machine.

---

## Evolution plan

### Phase 1
- write this design doc
- stabilize step model and state schema

### Phase 2
- implement `GET /api/setup/state`
- server aggregates first-version step states

### Phase 3
- build read-only setup UI
- render summary + steps + recommended actions

### Phase 4A (complete)
- `POST /api/setup/action` endpoint with explicit allowlist
- actions: `setup-refresh`, `bootstrap-preview`, `wrapper-reload`
- setup UI action bar with **Preview bootstrap** and **Reload wrapper** buttons
- inline action result display with auto-refresh of setup state

### Phase 4 (remaining)
- incrementally add further actions
  - bootstrap generate
  - install launchd (source / runtime)
  - run verification checks

### Phase 5
- expand module readiness as more integrations are added
  - camera
  - gesture
  - safe-edit
  - dist / build state
  - future external toolchains

---

## Why this sequencing matters

If we build the UI before defining the schema, the wizard is likely to become a collection of ad-hoc `if/else` checks in the frontend.

If we define the step model and setup-state contract first, then:

- backend aggregation stays coherent
- frontend rendering stays declarative
- actions can be added incrementally
- future module onboarding has a stable place to plug in

---

## One-sentence design summary

The setup wizard should begin as a **read-only deployment readiness model**: a server-owned ordered step graph with explicit statuses, evidence, and recommended actions, rendered by a simple setup UI and expanded into actionable workflow only after the state contract is stable.
