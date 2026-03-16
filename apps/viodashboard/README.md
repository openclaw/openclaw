# VioDashboard

A thin personal wrapper UI over OpenClaw gateway chat.

## Current MVP
- Connects to OpenClaw gateway as a backend client
- Sends `chat.send`
- Receives `chat` stream events
- Renders prompt/reply in a local web UI

## URL
- Default local URL: `http://127.0.0.1:8791`
- Overrideable via local config / env (`src/config.mjs`)

## LaunchAgent
Install:

```bash
bash VioDashboard/launchd/install.sh
```

Sync runtime after source changes:

```bash
bash VioDashboard/launchd/sync-runtime.sh
```

Status:

```bash
bash VioDashboard/launchd/status.sh
```

Uninstall:

```bash
bash VioDashboard/launchd/uninstall.sh
```

## Logs
- `~/Library/Logs/VioDashboard/wrapper.out.log`
- `~/Library/Logs/VioDashboard/wrapper.err.log`

## Current UI features
- Real-time websocket chat panel with streaming/final visual split
- Mood-linked UI states (`idle`, `thinking`, `streaming`, `waiting`, `error`)
- Telemetry for routing, tokens, total usage, estimated model window usage
- Lightweight local settings in Notes:
  - animations on/off
  - compact mode on/off
  - telemetry density normal/compact
- Dev/debug panel with workspace path, port, session key, current model, CSS/app hashes

## Server module layout
The original single-file server was split into small focused modules under `src/server/`:

- `src/server.mjs` — top-level HTTP/WebSocket wiring and high-level route dispatch
- `src/config.mjs` — shared paths, ports, and local wrapper config loading
- `src/server/gatewayBridge.mjs` — OpenClaw gateway WebSocket RPC client and chat bridging
- `src/server/filesystem.mjs` — safe project-root file listing/read/write helpers
- `src/server/gesture.mjs` — camera telemetry, gesture pipeline, watcher runtime
- `src/server/static.mjs` — static/public file and `/vio_cam/*` asset serving
- `src/server/httpUtils.mjs` — JSON request parsing and small response helpers
- `src/server/scripts.mjs` — reusable local script runner
- `src/server/utils.mjs` — small shared parsing helpers

This keeps behavior close to the previous implementation while making future open-source cleanup less painful.

## Architecture quick map
Use this section as the **default fast-entry file** when you need to re-understand `VioDashboard` quickly.

### System purpose
`VioDashboard` is not the OpenClaw core itself. It is a **local control-plane wrapper** around OpenClaw gateway chat that also exposes product-specific local capabilities.

Primary responsibilities:
- provide a browser UI for local chat/control workflows
- bridge the browser UI to the local wrapper server
- bridge the wrapper server to the current OpenClaw gateway
- expose local helper APIs for files, safe-edit, camera/gesture, task deploy, roadmap, and telemetry
- route assistant output into local product behaviors such as roadmap extraction, token-saver telemetry, and mood/body integration

### Architecture pattern
The module is best understood as a combination of:
- **layered architecture**
- **local wrapper / adapter layer**
- **integration hub** for local runtime services

### Five-layer view
#### 1. Presentation layer
Files:
- `public/index.html`
- `public/app.js`
- `public/styles.css`
- `public/telemetry.js`
- `public/dry-diff.js`

Responsibilities:
- chat and control UI
- telemetry/task board rendering
- file browser UI
- roadmap and token-saver visualization

#### 2. Application shell
Primary file:
- `src/server.mjs`

Responsibilities:
- start local HTTP and WebSocket servers
- register `/api/*` routes
- manage browser clients and runtime state
- compose gateway bridge, safe-edit, filesystem, gesture, static serving, and roadmap/task flows

This is the dashboard composition root and one of the main change hot zones.

#### 3. Environment / configuration boundary
Primary files:
- `src/config.mjs`
- `config/default.mjs`
- `config/local.example.mjs`
- `config/local.mjs` (gitignored, per-machine)

Responsibilities:
- project root and app directories
- wrapper port and gateway connection settings
- config source and token loading
- runtime/support/log directories
- camera and gesture real-path wiring
- separating repo defaults from machine-specific overrides

This is the main boundary where dashboard product logic meets machine-specific runtime reality.

#### 4. Integration adapters
Primary files:
- `src/server/gatewayBridge.mjs`
- `src/server/filesystem.mjs`
- `src/server/gesture.mjs`
- `src/server/static.mjs`
- `src/server/httpUtils.mjs`
- `src/server/scripts.mjs`
- `src/server/utils.mjs`

Responsibilities:
- gateway protocol and chat lifecycle bridging
- project-root-safe file access
- gesture/camera pipeline integration
- static file delivery
- HTTP helper functions and utility parsing

`gatewayBridge.mjs` is the most upstream-sensitive adapter and should be treated as a protocol boundary, not a dumping ground for unrelated product logic.

#### 5. Safety / operational subsystems
Primary files and directories:
- `src/server/safeEdit.mjs`
- `data/safe-edit/`
- `data/roadmap.json`
- `data/roadmap-history.json`
- `data/token-saver-debug/`

Responsibilities:
- safe-edit state and startup recovery
- roadmap persistence
- debug artifacts and token-saver observability
- operational evidence for local debugging and rollback

### Key runtime interfaces
#### Browser ↔ Dashboard
Main interfaces:
- HTTP `/api/*`
- WebSocket `/ws`

This is the northbound interface surface exposed to the UI.

#### Dashboard ↔ OpenClaw gateway
Primary adapter:
- `src/server/gatewayBridge.mjs`

This is the southbound protocol boundary and the most important compatibility-sensitive integration point.

#### Dashboard ↔ local machine/runtime
Main channels:
- filesystem access
- launchd/runtime copy flow
- local scripts
- camera/gesture runtime
- VioBody state polling

This is why `VioDashboard` should be treated as a local-first control console, not as a generic hosted web app.

### Most important non-functional concerns
For current development, the priority qualities are:
- **maintainability**
- **reliability**
- **observability**
- **security** for local file/script/runtime boundaries

Scalability matters far less than keeping this single-machine integration layer understandable and recoverable.

### Current hot zones
#### `src/server/gatewayBridge.mjs`
Why hot:
- protocol boundary
- helper resolution and gateway compatibility
- token-saver and roadmap-related integration logic
- highest upstream-drift sensitivity inside dashboard

#### `src/server.mjs`
Why hot:
- orchestration root
- many routes and runtime states converge here
- easy place for accidental architectural sprawl

#### `src/config.mjs`
Why hot:
- path, port, config source, and runtime wiring all converge here
- a mistake here misroutes the whole system

#### `src/server/safeEdit.mjs` + `data/safe-edit/`
Why hot:
- recovery and rollback safety
- errors here affect core development workflow confidence

#### runtime sync / launchd chain
Why hot:
- source vs runtime-copy divergence risk
- changes may appear correct in repo but fail in the live instance

### Recommended reading order for fast re-orientation
When reloading dashboard architecture quickly, read in this order:
1. this `README.md` section (`Architecture quick map`)
2. `src/config.mjs`
3. `src/server.mjs`
4. `src/server/gatewayBridge.mjs`
5. `ARCHITECTURE.md`

### One-sentence map
`VioDashboard` is a local layered control-plane app: browser UI on top, a wrapper application shell in the middle, gateway/filesystem/gesture/body adapters below it, and safe-edit/roadmap/debug state as the operational support layer.

## Smoke tests
Read-only smoke test against a running local wrapper:

```bash
npm run smoke
```

Optional checks:

```bash
# also probe the VioBody proxy when body is expected to be online
node scripts/smoke-test.mjs --body-check

# exercise /api/file POST and restore the file immediately after
node scripts/smoke-test.mjs --write-check
```

What the smoke test covers:
- `/api/health`
- cache-busted static asset serving (`/styles.css?v=...`)
- `/api/files` and `/api/file`
- project-root escape guard regression check
- `/api/camera`
- `/api/gesture/state`
- `/api/gesture/watcher` interval clamp regression check

## Debugging pitfalls
### 1) Edited CSS but page did not change
Most important check first: make sure the live wrapper is serving the workspace copy.

Wrong historical runtime path:
- `~/Library/Application Support/VioDashboardRuntime/public/styles.css`

Correct live source now:
- `<repo>/apps/viodashboard/public/styles.css`

If changes appear ignored:
1. Open `http://127.0.0.1:8791/styles.css?v=2`
2. Confirm the response contains the rule you just added
3. Check `~/Library/LaunchAgents/<your launchd plist>`
4. Confirm launchd starts from the current checkout's `apps/viodashboard`

### 2) Cache busting broke CSS
The wrapper server must resolve `requestUrl.pathname`, not raw `req.url`, otherwise `styles.css?v=2` becomes a fake filename and returns 404.

### 3) Token data is not in `chat` events
Gateway `chat` stream events do not currently include usage in this wrapper path. Token telemetry is derived by reading cumulative `sessions.usage` after final/error/aborted and diffing against the previous total.

### 4) Model Window is an estimate
`Model Window` is not provider-native live context occupancy. It is estimated from:
- current session model from `sessions.usage`
- model context window from `models.list`
- estimated prompt load from the latest usage delta

### 5) Long left-panel strings can break layout
If the left column starts overlapping chat, check for missing:
- `min-width: 0`
- ellipsis / nowrap handling
- constrained chip widths

## Stable snapshot
See `STABLE-SNAPSHOT.md` for the current known-good UI snapshot and restore checklist.


## Open-source readiness
- `LICENSE` — baseline license file
- `CONTRIBUTING.md` — contributor workflow and expectations
- `SECURITY.md` — current localhost-first trust model and reporting guidance
- `.env.example` — non-secret local configuration template

For now, the project should still be treated as **local-first / localhost-only** unless the auth model is strengthened further.


## Task lifecycle notes
Telemetry task state is currently local-first in the browser and now supports a lightweight v1 lifecycle:
- active statuses: `todo`, `doing`, `blocked`, `done_candidate`
- terminal/archive status: `done`
- deploy keeps `doing`
- active task cards support multi-select; when 2+ tasks are selected the UI shows a batch deploy toolbar
- roadmap candidate cards also support multi-select claim; when 2+ roadmap items are selected the Road Map panel shows a grouped claim toolbar that moves them into Task Board together without deploying them
- batch deploy sends selected tasks as one coordinated chat message while keeping task entities separate
- batch deploy records `batchId`, `deployedAt`, and a `batch_deployed` trace event on each selected task
- complete archives the task into `Task History`
- task history stores a compact trace of lifecycle events such as created, imported, batch_claimed, deployed, batch_deployed, blocked, reopened, done_candidate, completed, archived, and deleted
- roadmap history, task history, and deleted tasks each have independent two-step clear actions; roadmap history clearing goes through a backend confirm-guarded endpoint while task/deleted history remain local-first in browser storage
- `source=smoke-test` remains the special-case hook point for future auto-completion behavior, but normal tasks stay user-controlled in v1

## Roadmap API
The wrapper exposes structured roadmap data at:

```text
GET /api/roadmap
```

Roadmap production priority:
1. structured `vio-roadmap` JSON block embedded in the assistant final reply
2. fallback extraction from a `next steps` / `proposed next steps` bullet list

Wrapper send-path policy:
- outgoing wrapper chat messages now append a roadmap-output contract automatically
- this nudges the underlying model to emit a `vio-roadmap` block on every final reply
- fallback extraction remains as backup only, not the preferred source

Current persisted file:
- `VioDashboard/data/roadmap.json`


## Roadmap schema
See `ROADMAP_SCHEMA.md` for the structured roadmap payload contract and generation rules used by `/api/roadmap`.

The wrapper strips the roadmap block from visible chat output before rendering assistant replies, while still using it for `/api/roadmap`.

## Markdown rendering
Wrapper chat bubbles now render assistant/user markdown into formatted HTML instead of showing raw markdown source.
