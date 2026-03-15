# openclaw-workflow

**YAML/JSON-driven workflow orchestration for OpenClaw agents.**

Compose multi-step agent pipelines with dependency management, parallel execution, retry logic, output gates, and partial resume — all in a declarative YAML file.

---

## The Problem

OpenClaw subagents are powerful — but fire-and-forget. There's no native way to:
- Run agent B only after agent A succeeds
- Run agents A and B in parallel, then agent C when both finish
- Retry a flaky step before failing the whole pipeline
- Resume a partially-completed pipeline after a crash
- Validate that a step actually produced the expected output files

Developers work around this with shell scripts, manual timing, and fragile cron chains. `openclaw-workflow` solves this at the platform level.

---

## Installation

```bash
# From npm (once published)
cd ~/.openclaw/extensions
npm install openclaw-workflow

# From source (development)
git clone https://github.com/openclaw/openclaw.git
cd openclaw/plugins/openclaw-workflow
npm install
# Then symlink or copy to ~/.openclaw/extensions/openclaw-workflow/
```

Configure the plugin in your OpenClaw settings:

```json
{
  "openclaw-workflow": {
    "workflowsDir": "~/.openclaw/workflows",
    "runsDir": "~/.openclaw/workflow-runs",
    "baseDir": "/home/user/myproject",
    "concurrency": 3,
    "notifyChannel": "telegram",
    "sessionModel": "anthropic/claude-sonnet-4-6",
    "pollIntervalMs": 5000
  }
}
```

Create your workflows directory:

```bash
mkdir -p ~/.openclaw/workflows
```

---

## Quick Start (10 minutes)

**1. Create a workflow file:**

```bash
cat > ~/.openclaw/workflows/hello.yml << 'EOF'
name: Hello Pipeline
version: "1.0"
steps:
  - id: greet
    name: "Greeter"
    task: "Write a friendly greeting to output/hello-{date}.txt"
    timeout: 60
    outputs:
      - "output/hello-{date}.txt"

  - id: followup
    name: "Follow-up"
    depends_on: [greet]
    task: "Read the greeting from output/hello-{date}.txt and write a response to output/response-{date}.txt"
    timeout: 60
EOF
```

**2. List available workflows:**

```
workflow_list()
```

**3. Dry run (validate without executing):**

```
workflow_run({ name: "hello", dry_run: true })
```

**4. Run the pipeline:**

```
workflow_run({ name: "hello" })
# → { run_id: "hello-pipeline-20260309T082000", status: "running", ... }
```

**5. Check status:**

```
workflow_status({ name: "hello" })
# → { status: "ok", steps_ok: 2, steps_total: 2, ... }
```

---

## Workflow YAML Schema Reference

### Top-level fields

| Field         | Type     | Required | Default | Description |
|---------------|----------|----------|---------|-------------|
| `name`        | string   | ✅       | —       | Human display name. Used in notifications and slugified for run IDs. |
| `version`     | string   | ❌       | `"1.0"` | Schema version for future compatibility. |
| `description` | string   | ❌       | `""`    | Human description shown in `workflow_list`. |
| `steps`       | array    | ✅       | —       | Ordered list of step definitions. |
| `concurrency` | number   | ❌       | `3`     | Max steps that run in parallel. Range: 1–10. |

### Step fields

| Field          | Type      | Required | Default | Description |
|----------------|-----------|----------|---------|-------------|
| `id`           | string    | ✅       | —       | Unique step identifier. Must match `[a-zA-Z0-9_-]+`. Used in `depends_on` references and state files. |
| `name`         | string    | ❌       | Same as `id` | Human display name for notifications. |
| `task`         | string    | ✅       | —       | The agent prompt / task description. Supports [variable substitution](#variable-substitution). |
| `depends_on`   | string[]  | ❌       | `[]`    | IDs of steps that must complete (`ok`) before this step runs. |
| `outputs`      | string[]  | ❌       | `[]`    | File paths that must exist after the step completes. If any are missing, the step is marked `failed`. Supports [variable substitution](#variable-substitution). |
| `model`        | string    | ❌       | Plugin default | LLM model override for this step's session (e.g. `"anthropic/claude-opus-4"`). |
| `timeout`      | number    | ❌       | `300`   | Maximum execution time in **seconds**. Step is marked failed on timeout. |
| `retry`        | number    | ❌       | `0`     | Number of retry attempts after first failure. `retry: 2` = up to 3 total attempts. |
| `retry_delay`  | number    | ❌       | `30`    | Seconds to wait between retry attempts. |
| `optional`     | boolean   | ❌       | `false` | If `true`, step failure doesn't fail the pipeline or block dependent steps. |

---

## Variable Substitution

The following `{variable}` tokens are substituted in `task` and `outputs` fields at run time:

| Variable      | Example value                   | Description |
|---------------|---------------------------------|-------------|
| `{date}`      | `2026-03-09`                    | Current date as `YYYY-MM-DD` (UTC) |
| `{datetime}`  | `2026-03-09T08:20:00.000Z`      | Current datetime as ISO 8601 (UTC) |
| `{run_id}`    | `seo-pipeline-20260309T082000`  | The unique run identifier |

Unknown `{variables}` are left as-is (not an error).

**Example:**
```yaml
task: "Write audit to data/seo/{date}/report.json for run {run_id}"
outputs:
  - "data/seo/{date}/report.json"
```

---

## Tools Reference

### `workflow_run`

Start a workflow execution.

**Input:**
```json
{
  "name": "seo-pipeline",
  "dry_run": false,
  "resume": false
}
```

| Parameter  | Type    | Required | Description |
|------------|---------|----------|-------------|
| `name`     | string  | ✅       | Workflow file stem (e.g. `"seo-pipeline"` for `seo-pipeline.yml`) |
| `dry_run`  | boolean | ❌       | Validate and show execution plan without running. Default: `false` |
| `resume`   | boolean | ❌       | Skip steps that already completed in the last run. Default: `false` |

**Response (normal run):**
```json
{
  "run_id": "seo-pipeline-20260309T082000",
  "workflow": "SEO Daily Pipeline",
  "status": "running",
  "total_steps": 3,
  "steps": {
    "tech-auditor": { "status": "pending", "depends_on": [] },
    "content-creator": { "status": "pending", "depends_on": ["tech-auditor"] },
    "standup": { "status": "pending", "depends_on": ["tech-auditor", "content-creator"] }
  },
  "message": "Workflow \"SEO Daily Pipeline\" started. Use workflow_status to track progress."
}
```

**Response (dry run):**
```json
{
  "dry_run": true,
  "run_id": "seo-pipeline-20260309T082000",
  "total_steps": 3,
  "execution_waves": [
    [{ "id": "tech-auditor", "timeout_s": 420, "retry": 0, "optional": false }],
    [{ "id": "content-creator", "timeout_s": 600, "retry": 1, "optional": false }],
    [{ "id": "standup", "timeout_s": 300, "retry": 0, "optional": true }]
  ],
  "estimated_min_duration_s": 1320
}
```

---

### `workflow_status`

Check the status of a run.

**Input (by run_id):**
```json
{ "run_id": "seo-pipeline-20260309T082000" }
```

**Input (by name — returns most recent):**
```json
{ "name": "seo-pipeline" }
```

**Response:**
```json
{
  "run_id": "seo-pipeline-20260309T082000",
  "workflow": "SEO Daily Pipeline",
  "status": "running",
  "started_at": "2026-03-09T08:20:00.000Z",
  "completed_at": null,
  "elapsed_s": 210,
  "steps_ok": 1,
  "steps_failed": 0,
  "steps_total": 3,
  "steps": {
    "tech-auditor": {
      "status": "ok",
      "attempts": 1,
      "duration_s": 195,
      "error": null,
      "started_at": "2026-03-09T08:20:00.000Z",
      "completed_at": "2026-03-09T08:23:15.000Z"
    },
    "content-creator": {
      "status": "running",
      "attempts": 1,
      "duration_s": null,
      "error": null
    },
    "standup": {
      "status": "pending",
      "attempts": 0,
      "duration_s": null,
      "error": null
    }
  }
}
```

---

### `workflow_list`

List all available workflows and their last run status.

**Input:** (none required)

**Response:**
```json
{
  "workflows_dir": "/home/user/.openclaw/workflows",
  "count": 3,
  "workflows": [
    {
      "name": "data-pipeline",
      "display_name": "Data ETL Pipeline",
      "description": "Extract, Transform, Load pipeline...",
      "file": "/home/user/.openclaw/workflows/data-pipeline.yml",
      "last_run": {
        "run_id": "data-etl-pipeline-20260308T090000",
        "status": "ok",
        "started_at": "2026-03-08T09:00:00.000Z",
        "completed_at": "2026-03-08T09:14:22.000Z"
      }
    },
    {
      "name": "seo-pipeline",
      "display_name": "SEO Daily Pipeline",
      "description": "Daily SEO audit, content creation...",
      "file": "/home/user/.openclaw/workflows/seo-pipeline.yml",
      "last_run": null
    }
  ]
}
```

---

### `workflow_cancel`

Cancel a running workflow. In-flight steps finish; no new steps start.

**Input:**
```json
{ "run_id": "seo-pipeline-20260309T082000" }
```

**Response:**
```json
{
  "run_id": "seo-pipeline-20260309T082000",
  "status": "cancelled",
  "message": "Run \"seo-pipeline-20260309T082000\" marked as cancelled. 1 step(s) currently in-flight will complete: content-creator"
}
```

---

## State File Format

Each workflow run writes state to `{runsDir}/{run_id}.json`:

```json
{
  "run_id": "seo-pipeline-20260309T082000",
  "workflow": "SEO Daily Pipeline",
  "status": "ok",
  "started_at": "2026-03-09T08:20:00.000Z",
  "completed_at": "2026-03-09T08:47:12.000Z",
  "steps": {
    "tech-auditor": {
      "status": "ok",
      "started_at": "2026-03-09T08:20:00.000Z",
      "completed_at": "2026-03-09T08:23:15.000Z",
      "duration_ms": 195000,
      "session_key": "agent:main:subagent:abc123",
      "output_check": {
        "passed": true,
        "missing_files": [],
        "checked_files": ["/home/user/project/data/seo-state/ta-handoff-2026-03-09.json"]
      },
      "error": null,
      "attempts": 1
    }
  }
}
```

**Run status values:** `pending` | `running` | `ok` | `failed` | `cancelled`

**Step status values:** `pending` | `running` | `ok` | `failed` | `skipped`

- `skipped`: Step was never run because a non-optional dependency failed
- `failed`: Step ran but failed (either session error or output gate failed)
- `ok`: Step ran successfully and output gate passed (or no outputs defined)

---

## Notifications

When `notifyChannel` is configured, the plugin sends messages to that channel after each step:

```
✅ Technical Auditor complete (195s)
✅ Content Creator complete (462s)
✅ Standup Synthesis complete (88s)
🏁 Pipeline "SEO Daily Pipeline" complete — 3/3 steps passed
```

On failure:
```
❌ Content Creator failed — retrying (attempt 2/2)
❌ Content Creator failed after 2 attempt(s): Output gate failed — missing: data/seo-state/cc-memo-2026-03-09.md
⚠️  Standup Synthesis failed (optional — continuing pipeline)
💥 Pipeline "SEO Daily Pipeline" failed — 1 step(s) failed, 2/3 passed
```

---

## Execution Model

### Dependency Graph

Steps execute based on their `depends_on` graph. Steps with no dependencies (or all dependencies satisfied) are **ready** and launch immediately, up to the `concurrency` limit.

### Execution Waves Example

For this workflow:
```
A ──┐
    ├──→ C ──→ D
B ──┘
```

- **Wave 1**: A and B run in parallel
- **Wave 2**: C runs after both A and B finish
- **Wave 3**: D runs after C finishes

### Cascade Skip

When a non-optional step fails, all steps that depend on it (directly or transitively) are marked `skipped`. This prevents false failures and makes the status clear: the step didn't fail, it was never attempted.

### Resume

`workflow_run({ name: "...", resume: true })` loads the most recent run, finds all steps with `status: "ok"`, marks them as already-completed in the new run, and only executes the rest. Use this to recover from partial failures without re-doing expensive work.

---

## Examples

### SEO Pipeline (`examples/seo-pipeline.yml`)

Three sequential agents: Technical Auditor → Content Creator → Standup Synthesis. The Content Creator only runs if the Auditor wrote its handoff file. Standup is optional.

### Deploy Pipeline (`examples/deploy-pipeline.yml`)

Four-stage gate: test → build → deploy → smoke-test. Uses `concurrency: 1` to enforce strict sequencing. Deploy has `retry: 1` for flaky network situations.

### Data ETL Pipeline (`examples/data-pipeline.yml`)

Parallel fetch (primary + reference), then validate, transform, load, report. Demonstrates parallel steps fanning in to a single gate step, with the optional reporting stage at the end.

---

## Development & Testing

```bash
cd ~/.openclaw/extensions/openclaw-workflow
npm install

# Run the full test suite
node --test tests/

# Run a specific test file
node --test tests/workflow-loader.test.js

# Watch mode
node --test --watch tests/
```

All tests use Node.js built-in `node:test` and `assert` — no external test dependencies.

---

## PR Notes for OpenClaw Core Team

### Assumptions about OpenClaw internals

1. **Plugin API shape**: Based on studying `openclaw-aegis-notes`, I assume `api.registerTool({ name, description, parameters, execute })` is the correct registration interface, with `execute(_agentId, params)` signature and MCP content response format.

2. **`api.sessions` is not yet exposed**: The `step-runner.js` module has an `ApiAdapter` class designed for `api.sessions.spawn()` / `api.sessions.getStatus()`. Currently falls back to `CliAdapter` (runs `openclaw session run` as subprocess). **To enable native session spawning, OpenClaw needs to expose this API surface on the plugin `api` object.**

3. **Notifications via `console.log`**: Without access to the message-sending internals from within a plugin, notifications currently go to `console.log`. A proper `api.notify(channel, message)` method would be the right integration point.

4. **`notifyChannel` config**: Currently used as a label in console output. Once `api.notify` is available, the plugin should call `api.notify(config.notifyChannel, message)`.

### What OpenClaw should expose for full functionality

```typescript
interface PluginApi {
  // Already present:
  registerTool(tool: ToolDefinition): void;
  pluginConfig: Record<string, unknown>;

  // Needed for openclaw-workflow:
  sessions?: {
    spawn(prompt: string, options: SessionSpawnOptions): Promise<{ sessionId: string; sessionKey: string }>;
    getStatus(sessionId: string): Promise<{ status: 'running' | 'done' | 'error'; error?: string }>;
  };
  notify?(channel: string, message: string): Promise<void>;
}
```

### Files created

| File | Purpose |
|------|---------|
| `index.js` | Plugin entry: registers 4 tools |
| `workflow-loader.js` | YAML/JSON parsing, validation, cycle detection |
| `workflow-executor.js` | Core execution engine: scheduling, deps, retry, resume, dry run |
| `workflow-state.js` | Atomic state file R/W, run listing |
| `step-runner.js` | Session lifecycle: spawn, poll, output check. Includes MockAdapter |
| `output-checker.js` | File existence validation for output gates |
| `variable-substitution.js` | `{date}`, `{datetime}`, `{run_id}` substitution |
| `openclaw.plugin.json` | Plugin manifest + config schema |
| `package.json` | Package metadata |
| `tests/*.test.js` | Full test suite (Node built-in test runner) |
| `tests/fixtures/*.yml` | Fixture workflows for tests |
| `examples/*.yml` | SEO, deploy, and ETL example pipelines |

---

## Contributing

1. Fork the [openclaw/openclaw](https://github.com/openclaw/openclaw) repository
2. Copy this plugin to `plugins/openclaw-workflow/`
3. Run `npm install && node --test tests/` to verify tests pass
4. Submit a PR with the title: `feat: add openclaw-workflow orchestration plugin`

Please include test coverage for any new features or bug fixes.
