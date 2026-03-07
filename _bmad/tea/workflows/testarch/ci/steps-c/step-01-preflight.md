---
name: "step-01-preflight"
description: "Verify prerequisites and detect CI platform"
nextStepFile: "./step-02-generate-pipeline.md"
outputFile: "{test_artifacts}/ci-pipeline-progress.md"
---

# Step 1: Preflight Checks

## STEP GOAL

Verify CI prerequisites and determine target CI platform.

## MANDATORY EXECUTION RULES

- 📖 Read the entire step file before acting
- ✅ Speak in `{communication_language}`
- 🚫 Halt if requirements fail

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

## 1. Verify Git Repository

- `.git/` exists
- Remote configured (if available)

If missing: **HALT** with "Git repository required for CI/CD setup."

---

## 2. Detect Test Stack Type

Determine the project's test stack type (`test_stack_type`) using the following algorithm:

1. If `test_stack_type` is explicitly set in config (not `"auto"`), use that value.
2. Otherwise, auto-detect by scanning project manifests:
   - **Frontend indicators**: `playwright.config.*`, `cypress.config.*`, `vite.config.*`, `next.config.*`, `src/components/`, `src/pages/`, `src/app/`
   - **Backend indicators**: `pyproject.toml`, `pom.xml`/`build.gradle`, `go.mod`, `*.csproj`/`*.sln`, `Gemfile`, `Cargo.toml`, `jest.config.*`, `vitest.config.*`, `src/routes/`, `src/controllers/`, `src/api/`, `Dockerfile`, `serverless.yml`
   - **Both present** → `fullstack`
   - **Only frontend** → `frontend`
   - **Only backend** → `backend`
   - **Cannot determine** → default to `fullstack` and note assumption

Record detected `test_stack_type` in step output.

---

## 3. Verify Test Framework

- Check for framework configuration based on detected stack:
  - **Frontend/Fullstack**: `playwright.config.*` or `cypress.config.*` exists
  - **Backend (Node.js)**: `jest.config.*` or `vitest.config.*` or test scripts in `package.json`
  - **Backend (Python)**: `pyproject.toml` with `[tool.pytest]` or `pytest.ini` or `setup.cfg` with pytest config
  - **Backend (Java/Kotlin)**: `pom.xml` with surefire/failsafe plugins or `build.gradle` with test task
  - **Backend (Go)**: `*_test.go` files present (Go convention — no config file needed)
  - **Backend (C#/.NET)**: `*.csproj` with xUnit/NUnit/MSTest references
  - **Backend (Ruby)**: `Gemfile` with rspec or `.rspec` config file
- If `test_framework` is `"auto"`, detect from config files and project manifests found
- Verify test dependencies are installed (language-appropriate package manager)

If missing: **HALT** with "Run `framework` workflow first."

---

## 4. Ensure Tests Pass Locally

- Run the main test command based on detected stack and framework:
  - **Node.js**: `npm test` or `npm run test:e2e`
  - **Python**: `pytest` or `python -m pytest`
  - **Java**: `mvn test` or `gradle test`
  - **Go**: `go test ./...`
  - **C#/.NET**: `dotnet test`
  - **Ruby**: `bundle exec rspec`
- If failing: **HALT** and request fixes before CI setup

---

## 5. Detect CI Platform

- If `ci_platform` is explicitly set in config (not `"auto"`), use that value.
- Otherwise, scan for existing CI configuration files:
  - `.github/workflows/*.yml` → `github-actions`
  - `.gitlab-ci.yml` → `gitlab-ci`
  - `Jenkinsfile` → `jenkins`
  - `azure-pipelines.yml` → `azure-devops`
  - `.harness/*.yaml` → `harness`
  - `.circleci/config.yml` → `circle-ci`
- If found, ask whether to update or replace
- If not found, infer from git remote (github.com → `github-actions`, gitlab.com → `gitlab-ci`)
- If still unresolved, default to `github-actions`

Record detected `ci_platform` in step output.

---

## 6. Read Environment Context

- Read environment context based on detected stack:
  - **Node.js**: Read `.nvmrc` if present (default to Node 24+ LTS if missing); read `package.json` for dependency caching strategy
  - **Python**: Read `.python-version` or `pyproject.toml` for Python version; note `pip`/`poetry`/`pipenv` for caching
  - **Java**: Read `pom.xml`/`build.gradle` for Java version; note Maven/Gradle for caching
  - **Go**: Read `go.mod` for Go version; note Go module cache path
  - **C#/.NET**: Read `*.csproj`/`global.json` for .NET SDK version; note NuGet cache
  - **Ruby**: Read `.ruby-version` or `Gemfile` for Ruby version; note Bundler cache

---

### 7. Save Progress

**Save this step's accumulated work to `{outputFile}`.**

- **If `{outputFile}` does not exist** (first save), create it with YAML frontmatter:

  ```yaml
  ---
  stepsCompleted: ["step-01-preflight"]
  lastStep: "step-01-preflight"
  lastSaved: "{date}"
  ---
  ```

  Then write this step's output below the frontmatter.

- **If `{outputFile}` already exists**, update:
  - Add `'step-01-preflight'` to `stepsCompleted` array (only if not already present)
  - Set `lastStep: 'step-01-preflight'`
  - Set `lastSaved: '{date}'`
  - Append this step's output to the appropriate section of the document.

Load next step: `{nextStepFile}`

## 🚨 SYSTEM SUCCESS/FAILURE METRICS:

### ✅ SUCCESS:

- Step completed in full with required outputs

### ❌ SYSTEM FAILURE:

- Skipped sequence steps or missing outputs
  **Master Rule:** Skipping steps is FORBIDDEN.
