---
name: "step-04-docs-and-scripts"
description: "Document setup and add package.json scripts"
nextStepFile: "./step-05-validate-and-summary.md"
outputFile: "{test_dir}/README.md"
progressFile: "{test_artifacts}/framework-setup-progress.md"
---

# Step 4: Documentation & Scripts

## STEP GOAL

Create test documentation and add build/test scripts appropriate for `{detected_stack}`.

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

## 1. tests/README.md

Create `{outputFile}` and include:

- Setup instructions
- Running tests (local/headed/debug)
- Architecture overview (fixtures, factories, helpers)
- Best practices (selectors, isolation, cleanup)
- CI integration notes
- Knowledge base references

---

## 2. Build & Test Scripts

**If {detected_stack} is `frontend` or `fullstack`:**

Add to `package.json` at minimum:

- `test:e2e`: framework execution command (e.g., `npx playwright test`)

**If {detected_stack} is `backend` or `fullstack`:**

Add the idiomatic test commands for the detected framework:

- **Python (pytest)**: Add to `pyproject.toml` scripts or `Makefile`: `pytest`, `pytest --cov`, `pytest -m integration`
- **Java (JUnit)**: Add to `build.gradle`/`pom.xml`: `./gradlew test`, `mvn test`, `mvn verify` (integration)
- **Go**: Add to `Makefile`: `go test ./...`, `go test -race ./...`, `go test -cover ./...`
- **C#/.NET**: Add to CI scripts or `Makefile`: `dotnet test`, `dotnet test --collect:"XPlat Code Coverage"`
- **Ruby (RSpec)**: Add to `Gemfile` binstubs or `Makefile`: `bundle exec rspec`, `bundle exec rspec spec/integration`

---

### 3. Save Progress

**Save this step's accumulated work to `{progressFile}`.**

- **If `{progressFile}` does not exist** (first save), create it with YAML frontmatter:

  ```yaml
  ---
  stepsCompleted: ["step-04-docs-and-scripts"]
  lastStep: "step-04-docs-and-scripts"
  lastSaved: "{date}"
  ---
  ```

  Then write this step's output below the frontmatter.

- **If `{progressFile}` already exists**, update:
  - Add `'step-04-docs-and-scripts'` to `stepsCompleted` array (only if not already present)
  - Set `lastStep: 'step-04-docs-and-scripts'`
  - Set `lastSaved: '{date}'`
  - Append this step's output to the appropriate section of the document.

Load next step: `{nextStepFile}`

## 🚨 SYSTEM SUCCESS/FAILURE METRICS:

### ✅ SUCCESS:

- Step completed in full with required outputs

### ❌ SYSTEM FAILURE:

- Skipped sequence steps or missing outputs
  **Master Rule:** Skipping steps is FORBIDDEN.
