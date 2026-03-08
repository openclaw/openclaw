---
name: "step-03-configure-quality-gates"
description: "Configure burn-in, quality gates, and notifications"
nextStepFile: "./step-04-validate-and-summary.md"
knowledgeIndex: "{project-root}/_bmad/tea/testarch/tea-index.csv"
outputFile: "{test_artifacts}/ci-pipeline-progress.md"
---

# Step 3: Quality Gates & Notifications

## STEP GOAL

Configure burn-in loops, quality thresholds, and notification hooks.

## MANDATORY EXECUTION RULES

- 📖 Read the entire step file before acting
- ✅ Speak in `{communication_language}`

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

## 1. Burn-In Configuration

Use `{knowledgeIndex}` to load `ci-burn-in.md` guidance:

- Run N-iteration burn-in for flaky detection
- Gate promotion based on burn-in stability

**Stack-conditional burn-in:**

- **Frontend or Fullstack** (`test_stack_type` is `frontend` or `fullstack`): Enable burn-in by default. Burn-in targets UI flakiness (race conditions, selector instability, timing issues).
- **Backend only** (`test_stack_type` is `backend`): Skip burn-in by default. Backend tests (unit, integration, API) are deterministic and rarely exhibit UI-related flakiness. If the user explicitly requests burn-in for backend, honor that override.

**Security: Script injection prevention for reusable burn-in workflows:**

When burn-in is extracted into a reusable workflow (`on: workflow_call`), all `${{ inputs.* }}` values MUST be passed through `env:` intermediaries and referenced as quoted `"$ENV_VAR"`. Never interpolate them directly.

**Inputs must be DATA, not COMMANDS.** Do not accept command-shaped inputs (e.g., `inputs.install-command`, `inputs.test-command`) that get executed as shell code — even through `env:`, running `$CMD` is still command injection. Use fixed commands (e.g., `npm ci`, `npx playwright test`) and pass inputs only as data arguments.

```yaml
# ✅ SAFE — fixed commands with data-only inputs
- name: Install dependencies
  run: npm ci
- name: Run burn-in loop
  env:
    TEST_GREP: ${{ inputs.test-grep }}
    BURN_IN_COUNT: ${{ inputs.burn-in-count }}
    BASE_REF: ${{ inputs.base-ref }}
  run: |
    # Security: inputs passed through env: to prevent script injection
    for i in $(seq 1 "$BURN_IN_COUNT"); do
      echo "Burn-in iteration $i/$BURN_IN_COUNT"
      npx playwright test --grep "$TEST_GREP" || exit 1
    done
```

---

## 2. Quality Gates

Define:

- Minimum pass rates (P0 = 100%, P1 ≥ 95%)
- Fail CI on critical test failures
- Optional: require traceability or nfr-assess output before release

**Contract testing gate** (if `tea_use_pactjs_utils` is enabled):

- **can-i-deploy must pass** before any deployment to staging or production
- Block the deployment pipeline if contract verification fails
- Treat consumer pact publishing failures as CI failures (contracts must stay up-to-date)
- Provider verification must pass for all consumer pacts before merge

---

## 3. Notifications

Configure:

- Failure notifications (Slack/email)
- Artifact links

---

### 4. Save Progress

**Save this step's accumulated work to `{outputFile}`.**

- **If `{outputFile}` does not exist** (first save), create it with YAML frontmatter:

  ```yaml
  ---
  stepsCompleted: ["step-03-configure-quality-gates"]
  lastStep: "step-03-configure-quality-gates"
  lastSaved: "{date}"
  ---
  ```

  Then write this step's output below the frontmatter.

- **If `{outputFile}` already exists**, update:
  - Add `'step-03-configure-quality-gates'` to `stepsCompleted` array (only if not already present)
  - Set `lastStep: 'step-03-configure-quality-gates'`
  - Set `lastSaved: '{date}'`
  - Append this step's output to the appropriate section of the document.

Load next step: `{nextStepFile}`

## 🚨 SYSTEM SUCCESS/FAILURE METRICS:

### ✅ SUCCESS:

- Step completed in full with required outputs

### ❌ SYSTEM FAILURE:

- Skipped sequence steps or missing outputs
  **Master Rule:** Skipping steps is FORBIDDEN.
