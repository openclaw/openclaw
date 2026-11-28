## Validation

For docs/skill-only changes, check the edited Markdown, its source claims and
links, and `git diff --check`; runtime suites are unnecessary. For workflow or
planner changes, use the changed-file plan and focused tests for the touched
contract. These are available checks, not a mandatory bundle for every edit:

```bash
node scripts/run-vitest.mjs test/scripts/ci-workflow-guards.test.ts test/scripts/ci-workflow-planning.test.ts test/scripts/ci-workflow-evidence.test.ts
node --import tsx scripts/check-workflows.mts
node scripts/docs-list.js
./node_modules/.bin/oxfmt --check .github/workflows/ci.yml .github/workflows/codeql-critical-quality.yml docs/ci.md test/scripts/ci-workflow-guards.test.ts test/scripts/ci-workflow-planning.test.ts test/scripts/ci-workflow-evidence.test.ts test/scripts/ci-workflow.test-support.ts .agents/skills/openclaw-ci-limits/SKILL.md .agents/skills/openclaw-ci-limits/agents/openai.yaml
git diff --check
```

If `pnpm docs:list` tries to reconcile dependencies in a linked Codex worktree,
stop and use `node scripts/docs-list.js`.

Follow the [shared review setup](../../autoreview/SKILL.md) and the
[maintainer landing workflow](../../openclaw-pr-maintainer/references/landing.md)
for review, proof, and authorized landing. Bind any CI watcher to the PR's full
40-character head SHA:

```bash
python3 "$HOME/.agents/skills/autoreview/scripts/autoreview" --mode branch --base origin/main
node scripts/watch-pr-ci.mjs <pr> <head-sha> --repo openclaw/openclaw
```

Focused local proof; PR CI = broad proof. Testbox only for CI/local gaps, immediate grant.
Observe existing CI; never dispatch/rerun/re-push just for green.
CI fails → `pnpm test:ci-failed <pr>`; read classification, fix new failures →
`pnpm test:ci-failed <pr> --run` until local pass → push once. Never local full-suite CI repair.
Proven red-main repairs: maintainer workflow direct-main rule. Other changes:
native PR route under existing user authorization. Never combine
`OPENCLAW_TESTBOX=1` with `OPENCLAW_PR_GATES_REMOTE=github`.

## Post-Land Monitoring

After merge, watch at least one fresh main cycle and the adjacent repos:

```bash
gh run list -R openclaw/openclaw --limit 20 --json databaseId,status,conclusion,workflowName,event,headBranch,createdAt,updatedAt,url
for repo in openclaw/clawsweeper openclaw/clawhub openclaw/clownfish openclaw/openclaw-rtt openclaw/clawbench; do
  gh run list -R "$repo" --limit 12 --json databaseId,status,conclusion,workflowName,event,headBranch,createdAt,updatedAt,url
done
curl -fsS https://clawsweeper.openclaw.ai/api/exact-review-queue | jq '.'
```

Report:

- exact PR/commit landed;
- expected registration reduction or added headroom;
- CI run status and slowest/queued jobs;
- queued job labels, runner assignment, and dependency state for any outlier;
- Blacksmith Actions runner evidence separately from Testbox control-plane
  health;
- ClawSweeper queue pending, dispatching, leased, oldest pending age;
- publication net drain/dead letters, state-writer queued/waiting, and state
  append rows/bytes/oldest item;
- any real failures that remain outside runner registration.
