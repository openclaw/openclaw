---
name: "step-02-generate-pipeline"
description: "Generate CI pipeline configuration with adaptive orchestration (agent-team, subagent, or sequential)"
nextStepFile: "./step-03-configure-quality-gates.md"
outputFile: "{test_artifacts}/ci-pipeline-progress.md"
---

# Step 2: Generate CI Pipeline

## STEP GOAL

Create platform-specific CI configuration with test execution, sharding, burn-in, and artifacts.

## MANDATORY EXECUTION RULES

- 📖 Read the entire step file before acting
- ✅ Speak in `{communication_language}`
- ✅ Resolve execution mode from explicit user request first, then config
- ✅ Apply fallback rules deterministically when requested mode is unsupported

---

## EXECUTION PROTOCOLS:

- 🎯 Follow the MANDATORY SEQUENCE exactly
- 💾 Record outputs before proceeding
- 📖 Load the next step only when instructed

## CONTEXT BOUNDARIES:

- Available context: config, loaded artifacts, and knowledge fragments
- Focus: this step's goal only
- Limits: do not execute future steps
- Dependencies: prior steps' outputs (if any)

## MANDATORY SEQUENCE

**CRITICAL:** Follow this sequence exactly. Do not skip, reorder, or improvise.

## 0. Resolve Execution Mode (User Override First)

```javascript
const orchestrationContext = {
  config: {
    execution_mode: config.tea_execution_mode || "auto", // "auto" | "subagent" | "agent-team" | "sequential"
    capability_probe: config.tea_capability_probe !== false, // true by default
  },
  timestamp: new Date().toISOString().replace(/[:.]/g, "-"),
};

const normalizeUserExecutionMode = (mode) => {
  if (typeof mode !== "string") return null;
  const normalized = mode.trim().toLowerCase().replace(/[-_]/g, " ").replace(/\s+/g, " ");

  if (normalized === "auto") return "auto";
  if (normalized === "sequential") return "sequential";
  if (
    normalized === "subagent" ||
    normalized === "sub agent" ||
    normalized === "subagents" ||
    normalized === "sub agents"
  ) {
    return "subagent";
  }
  if (normalized === "agent team" || normalized === "agent teams" || normalized === "agentteam") {
    return "agent-team";
  }

  return null;
};

const normalizeConfigExecutionMode = (mode) => {
  if (mode === "subagent") return "subagent";
  if (mode === "auto" || mode === "sequential" || mode === "subagent" || mode === "agent-team") {
    return mode;
  }
  return null;
};

// Explicit user instruction in the active run takes priority over config.
const explicitModeFromUser = normalizeUserExecutionMode(
  runtime.getExplicitExecutionModeHint?.() || null,
);

const requestedMode =
  explicitModeFromUser ||
  normalizeConfigExecutionMode(orchestrationContext.config.execution_mode) ||
  "auto";
const probeEnabled = orchestrationContext.config.capability_probe;

const supports = { subagent: false, agentTeam: false };
if (probeEnabled) {
  supports.subagent = runtime.canLaunchSubagents?.() === true;
  supports.agentTeam = runtime.canLaunchAgentTeams?.() === true;
}

let resolvedMode = requestedMode;
if (requestedMode === "auto") {
  if (supports.agentTeam) resolvedMode = "agent-team";
  else if (supports.subagent) resolvedMode = "subagent";
  else resolvedMode = "sequential";
} else if (probeEnabled && requestedMode === "agent-team" && !supports.agentTeam) {
  resolvedMode = supports.subagent ? "subagent" : "sequential";
} else if (probeEnabled && requestedMode === "subagent" && !supports.subagent) {
  resolvedMode = "sequential";
}
```

Resolution precedence:

1. Explicit user request in this run (`agent team` => `agent-team`; `subagent` => `subagent`; `sequential`; `auto`)
2. `tea_execution_mode` from config
3. Runtime capability fallback (when probing enabled)

## 1. Resolve Output Path and Select Template

Determine the pipeline output file path based on the detected `ci_platform`:

| CI Platform      | Output Path                                 | Template File                                       |
| ---------------- | ------------------------------------------- | --------------------------------------------------- |
| `github-actions` | `{project-root}/.github/workflows/test.yml` | `{installed_path}/github-actions-template.yaml`     |
| `gitlab-ci`      | `{project-root}/.gitlab-ci.yml`             | `{installed_path}/gitlab-ci-template.yaml`          |
| `jenkins`        | `{project-root}/Jenkinsfile`                | `{installed_path}/jenkins-pipeline-template.groovy` |
| `azure-devops`   | `{project-root}/azure-pipelines.yml`        | `{installed_path}/azure-pipelines-template.yaml`    |
| `harness`        | `{project-root}/.harness/pipeline.yaml`     | `{installed_path}/harness-pipeline-template.yaml`   |
| `circle-ci`      | `{project-root}/.circleci/config.yml`       | _(no template; generate from first principles)_     |

Use templates from `{installed_path}` when available. Adapt the template to the project's `test_stack_type` and `test_framework`.

---

## Security: Script Injection Prevention

> **CRITICAL:** Treat `${{ inputs.* }}` and the entire `${{ github.event.* }}` namespace as unsafe by default. ALWAYS route them through `env:` intermediaries and reference as double-quoted `"$ENV_VAR"` in `run:` blocks. NEVER interpolate them directly.

When the generated pipeline is extended into reusable workflows (`on: workflow_call`), manual dispatch (`on: workflow_dispatch`), or composite actions, these values become user-controllable and can inject arbitrary shell commands.

**Two rules for generated `run:` blocks:**

1. **No direct interpolation** — pass unsafe contexts through `env:`, reference as `"$ENV_VAR"`
2. **Inputs must be DATA, not COMMANDS** — never accept command-shaped inputs (e.g., `inputs.install-command`) that get executed as shell code. Even through `env:`, running `$CMD` where CMD comes from an input is still command injection. Use fixed commands and pass inputs only as arguments.

```yaml
# ✅ SAFE — input is DATA interpolated into a fixed command
- name: Run tests
  env:
    TEST_GREP: ${{ inputs.test-grep }}
  run: |
    # Security: inputs passed through env: to prevent script injection
    npx playwright test --grep "$TEST_GREP"

# ❌ NEVER — direct GitHub expression injection
- name: Run tests
  run: |
    npx playwright test --grep "${{ inputs.test-grep }}"

# ❌ NEVER — executing input-derived env var as a command
- name: Install
  env:
    CMD: ${{ inputs.install-command }}
  run: $CMD
```

Include a `# Security: inputs passed through env: to prevent script injection` comment in generated YAML wherever this pattern is applied.

**Safe contexts** (do NOT need `env:` intermediaries): `${{ steps.*.outputs.* }}`, `${{ matrix.* }}`, `${{ runner.os }}`, `${{ github.sha }}`, `${{ github.ref }}`, `${{ secrets.* }}`, `${{ env.* }}`.

---

## 2. Pipeline Stages

Include stages:

- lint
- test (parallel shards)
- contract-test (if `tea_use_pactjs_utils` enabled)
- burn-in (flaky detection)
- report (aggregate + publish)

---

## 3. Test Execution

- Parallel sharding enabled
- CI retries configured
- Capture artifacts (HTML report, JUnit XML, traces/videos on failure)
- Cache dependencies (language-appropriate: node_modules, .venv, .m2, go module cache, NuGet, bundler)

Write the selected pipeline configuration to the resolved output path from step 1. Adjust test commands based on `test_stack_type` and `test_framework`:

- **Frontend/Fullstack**: Include browser install, E2E/component test commands, Playwright/Cypress artifacts
- **Backend (Node.js)**: Use `npm test` or framework-specific commands (`vitest`, `jest`), skip browser install
- **Backend (Python)**: Use `pytest` with coverage (`pytest --cov`), install via `pip install -r requirements.txt` or `poetry install`
- **Backend (Java/Kotlin)**: Use `mvn test` or `gradle test`, cache `.m2/repository` or `.gradle/caches`
- **Backend (Go)**: Use `go test ./...` with coverage (`-coverprofile`), cache Go modules
- **Backend (C#/.NET)**: Use `dotnet test` with coverage, restore NuGet packages
- **Backend (Ruby)**: Use `bundle exec rspec` with coverage, cache `vendor/bundle`

### Contract Testing Pipeline (if `tea_use_pactjs_utils` enabled)

When `tea_use_pactjs_utils` is enabled, add a `contract-test` stage after `test`:

**Required env block** (add to the generated pipeline):

```yaml
env:
  PACT_BROKER_BASE_URL: ${{ secrets.PACT_BROKER_BASE_URL }}
  PACT_BROKER_TOKEN: ${{ secrets.PACT_BROKER_TOKEN }}
  GITHUB_SHA: ${{ github.sha }} # auto-set by GitHub Actions
  GITHUB_BRANCH: ${{ github.head_ref || github.ref_name }} # NOT auto-set — must be defined explicitly
```

> **Note:** `GITHUB_SHA` is auto-set by GitHub Actions, but `GITHUB_BRANCH` is **not** — it must be derived from `github.head_ref` (for PRs) or `github.ref_name` (for pushes). The pactjs-utils library reads both from `process.env`.

1. **Consumer test + publish**: Run consumer contract tests, then publish pacts to broker
   - `npm run test:pact:consumer`
   - `npm run publish:pact`
   - Only publish on PR and main branch pushes

2. **Provider verification**: Run provider verification against published pacts
   - `npm run test:pact:provider:remote:contract`
   - `buildVerifierOptions` auto-reads `PACT_BROKER_BASE_URL`, `PACT_BROKER_TOKEN`, `GITHUB_SHA`, `GITHUB_BRANCH`
   - Verification results published to broker when `CI=true`

3. **Can-I-Deploy gate**: Block deployment if contracts are incompatible
   - `npm run can:i:deploy:provider`
   - Ensure the script adds `--retry-while-unknown 6 --retry-interval 10` for async verification

4. **Webhook job**: Add `repository_dispatch` trigger for `pact_changed` event
   - Provider verification runs when consumers publish new pacts
   - Ensures compatibility is checked on both consumer and provider changes

5. **Breaking change handling**: When `PACT_BREAKING_CHANGE=true` env var is set:
   - Provider test passes `includeMainAndDeployed: false` to `buildVerifierOptions` — verifies only matching branch
   - Coordinate with consumer team before removing the flag

6. **Record deployment**: After successful deployment, record version in broker
   - `npm run record:provider:deployment --env=production`

Required CI secrets: `PACT_BROKER_BASE_URL`, `PACT_BROKER_TOKEN`

**If `tea_pact_mcp` is `"mcp"`:** Reference the SmartBear MCP `Can I Deploy` and `Matrix` tools for pipeline guidance in `pact-mcp.md`.

---

### 4. Save Progress

**Save this step's accumulated work to `{outputFile}`.**

- **If `{outputFile}` does not exist** (first save), create it with YAML frontmatter:

  ```yaml
  ---
  stepsCompleted: ["step-02-generate-pipeline"]
  lastStep: "step-02-generate-pipeline"
  lastSaved: "{date}"
  ---
  ```

  Then write this step's output below the frontmatter.

- **If `{outputFile}` already exists**, update:
  - Add `'step-02-generate-pipeline'` to `stepsCompleted` array (only if not already present)
  - Set `lastStep: 'step-02-generate-pipeline'`
  - Set `lastSaved: '{date}'`
  - Append this step's output to the appropriate section of the document.

### 5. Orchestration Notes for This Step

For this step, treat these work units as parallelizable when `resolvedMode` is `agent-team` or `subagent`:

- Worker A: resolve platform path/template and produce base pipeline skeleton (section 1)
- Worker B: construct stage definitions and test execution blocks (sections 2-3)
- Worker C: contract-testing block (only when `tea_use_pactjs_utils` is true)

If `resolvedMode` is `sequential`, execute sections 1→4 in order.

Load next step: `{nextStepFile}`

## 🚨 SYSTEM SUCCESS/FAILURE METRICS:

### ✅ SUCCESS:

- Step completed in full with required outputs

### ❌ SYSTEM FAILURE:

- Skipped sequence steps or missing outputs
  **Master Rule:** Skipping steps is FORBIDDEN.
