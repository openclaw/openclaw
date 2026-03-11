# E2E Multi-OS CI Roadmap — Long-Horizon Task

> **Goal**: Establish an end-to-end automated testing framework that validates OpenClaw across major server and local environments, with self-iteration capability until all target platforms pass.

## 1. Research Summary — CI/CD Best Practices

### 1.1 Multi-OS Matrix Strategy (GitHub Actions)

| Practice | Source | Application |
|----------|--------|-------------|
| `fail-fast: false` | [GitHub Docs](https://docs.github.com/en/actions/using-jobs/using-a-matrix-for-your-jobs) | Run all matrix jobs even if one fails; faster feedback |
| `include` / `exclude` | [OneUptime](https://oneuptime.com/blog/post/2025-12-20-github-actions-matrix-include-exclude/view) | Skip unsupported combos (e.g. Windows ARM64); add platform-specific tests |
| Dynamic matrix | [CodeStudy](https://www.codestudy.net/blog/how-do-i-make-a-github-action-matrix-element-conditional/) | Adapt matrix from `workflow_dispatch` inputs or path filters |
| OS-specific caching | [Codefresh](https://codefresh.io/learn/github-actions/github-actions-matrix/) | Cache key includes `${{ matrix.os }}` to avoid cross-OS pollution |
| `timeout-minutes` | [Playwright CI](https://playwright.dev/docs/ci) | Prevent hung jobs |

### 1.2 E2E Testing Patterns

| Practice | Source | Application |
|----------|--------|-------------|
| Sharding for large suites | [Playwright](https://playwright.dev/docs/ci) | Distribute tests across matrix jobs |
| `workers: 1` in CI | [Playwright](https://playwright.dev/docs/ci) | Stability and reproducibility |
| Artifact on failure only | [DEV Community](https://dev.to/drakulavich/fast-and-reliable-end-to-end-tests-with-playwright-on-github-actions-2mkh) | `if: failure()` to upload logs |
| Phased rollout | [Compile N Run](https://compilenrun.com/docs/devops/cicd/cicd-deployment-strategies/cicd-phased-rollout) | Feature flags or gradual matrix expansion |

### 1.3 Self-Healing / Self-Iteration

| Pattern | Source | Application |
|---------|--------|-------------|
| Failure → Agent → Fix → Re-run | [Dagger](https://dagger.io/blog/automate-your-ci-fixes-self-healing-pipelines-with-ai-agents), [Semaphore](https://semaphore.io/blog/self-healing-ci) | Agent reads logs, applies fix, validates, proposes PR |
| Constrained tools | [Dagger](https://dagger.io/blog/automate-your-ci-fixes-self-healing-pipelines-with-ai-agents) | ReadFile, WriteFile, RunTests, RunLint — expose as tools |
| Context-aware | [Nx](https://canary.nx.dev/docs/features/ci-features/self-healing-ci) | Agent understands workspace structure |

**OpenClaw adaptation**: No Dagger required. Use Cursor/agent with:
- `gh run view <id> --log-failed` to fetch failure context
- Edit workflow YAML or test scripts
- Re-trigger via `workflow_dispatch` or empty commit
- Iterate until `gh run list` shows success

---

## 2. Target Environments (Matrix)

| Environment | Runner | Priority | Notes |
|-------------|--------|----------|-------|
| **Ubuntu** | `ubuntu-latest` or `blacksmith-16vcpu-ubuntu-2404` | P0 | Primary server; Docker E2E here |
| **Windows** | `windows-latest` or `blacksmith-32vcpu-windows-2025` | P0 | Path handling, PowerShell |
| **macOS** | `macos-latest` | P1 | Limited concurrency; PR-only or path-filter |
| **Docker (Linux)** | Ubuntu + Docker | P0 | onboard, gateway-network, etc. |

---

## 3. Phased Rollout Plan

### Phase 0: Foundation (Current)

- [x] Create `docs/experiments/plans/e2e-multi-os-ci-roadmap.md` (this doc)
- [x] Add `workflow_dispatch` to a new workflow for manual iteration
- [x] Define minimal smoke commands per OS

### Phase 1: CLI Smoke (Ubuntu, Windows, macOS)

- [x] New workflow: `e2e-multi-os.yml`
- [x] Matrix: `os: [ubuntu-latest, windows-latest, macos-latest]`
- [x] Steps: checkout → setup Node → pnpm install → pnpm build → `openclaw --version` → `openclaw doctor`
- [x] `fail-fast: false`, `timeout-minutes: 30`
- [x] Trigger: `push` (main), `pull_request`, `workflow_dispatch`
- [ ] Success criteria: All 3 OS jobs green (self-iterate until pass)

### Phase 2: Vitest E2E (Ubuntu first)

- [ ] Add job: `pnpm test:e2e` on Ubuntu
- [ ] Reuse `ci.yml` build-artifacts if available
- [ ] Success criteria: E2E suite passes on Ubuntu

### Phase 3: Docker E2E (Ubuntu)

- [ ] Add job: `pnpm test:docker:onboard` (and optionally gateway-network, etc.)
- [ ] Requires Docker: use `useblacksmith/setup-docker-builder` or host Docker
- [ ] Success criteria: Onboard Docker E2E passes

### Phase 4: Vitest E2E on Windows / macOS

- [ ] Extend matrix: run `pnpm test:e2e` on Windows and macOS
- [ ] Use `include`/`exclude` if platform-specific skips needed
- [ ] Success criteria: E2E passes on all 3 OS

### Phase 5: Self-Iteration Loop

- [ ] Document agent workflow: fetch failure → analyze → fix → re-trigger
- [ ] Optional: `workflow_dispatch` input `phase` to run subset (e.g. only Phase 1)
- [ ] Optional: Store last-run status in a small artifact (e.g. `e2e-status.json`) for agent to read

---

## 4. Self-Iteration Loop (Agent Instructions)

When an E2E workflow fails:

1. **Fetch context**
   ```bash
   gh run list --workflow "e2e-multi-os.yml" -L 1
   gh run view <id> --log-failed
   ```

2. **Identify root cause**
   - Path separator (Windows `\` vs `/`)
   - Shell: PowerShell vs bash on Windows
   - Missing deps (e.g. `jq`, `trash`)
   - Timeout or flakiness

3. **Apply fix**
   - Edit `.github/workflows/e2e-multi-os.yml` or test scripts
   - Use `defaults.run.shell: bash` on Windows when possible
   - Add platform-specific `if` or `continue-on-error` for experimental lanes

4. **Re-trigger**
   ```bash
   git add -A && git commit -m "fix(ci): ..." && git push
   # or: gh workflow run e2e-multi-os.yml
   ```

5. **Verify**
   ```bash
   gh run list --workflow "e2e-multi-os.yml" -L 1
   gh run watch <id>
   ```

6. **Repeat** until all matrix jobs pass.

---

## 5. Workflow Skeleton (Phase 1)

```yaml
name: E2E Multi-OS

on:
  push:
    branches: [main]
  pull_request:
  workflow_dispatch:
    inputs:
      phase:
        description: 'Phase to run'
        required: false
        default: 'smoke'
        type: choice
        options:
          - smoke
          - e2e
          - docker

jobs:
  e2e-smoke:
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, windows-latest, macos-latest]
    runs-on: ${{ matrix.os }}
    timeout-minutes: 30
    defaults:
      run:
        shell: bash
    steps:
      - uses: actions/checkout@v4
      - uses: ./.github/actions/setup-node-env
        with:
          install-bun: "false"
      - name: Build
        run: pnpm build
      - name: CLI smoke
        run: |
          pnpm exec openclaw --version
          pnpm exec openclaw doctor
```

---

## 6. Changelog (Self-Iteration Log)

| Date | Change | Status |
|------|--------|--------|
| (initial) | Roadmap created | — |
| 2026-03-11 | Phase 1 workflow added: e2e-multi-os.yml | Pending first run |

---

## 7. References

- [GitHub Actions Matrix](https://docs.github.com/en/actions/using-jobs/using-a-matrix-for-your-jobs)
- [Playwright CI](https://playwright.dev/docs/ci)
- [Dagger Self-Healing CI](https://dagger.io/blog/automate-your-ci-fixes-self-healing-pipelines-with-ai-agents)
- [OpenClaw docs/help/testing.md](/docs/help/testing.md)
