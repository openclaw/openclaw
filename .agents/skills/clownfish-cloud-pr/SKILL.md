---
name: clownfish-cloud-pr
description: Use when launching Clownfish in GitHub Actions to create or update one guarded GitHub implementation PR from issue/PR refs, a ClawSweeper report, or a custom maintainer prompt.
---

# Clownfish Cloud PR

Use this skill when the user wants Codex to ask Clownfish to create a PR in the
cloud from issue/PR refs plus a custom prompt.

## Create One Job

```bash
cd ~/Projects/clownfish
git status --short --branch
gh variable list --repo openclaw/clownfish --json name,value \
  --jq 'map(select(.name|test("^CLOWNFISH_"))) | sort_by(.name) | .[] | {name,value}'
npm run create-job -- \
  --repo openclaw/openclaw \
  --refs 123,456 \
  --prompt-file /tmp/clownfish-prompt.md
```

From a ClawSweeper report:

```bash
npm run create-job -- \
  --from-report ../clawsweeper/records/openclaw-openclaw/items/123.md
```

The script checks for an existing open PR/body match and remote branch named
`clownfish/<cluster-id>` before writing a duplicate job. Use `--dry-run` to
inspect the exact job body.

## Ask For A Replacement PR

The skill can trigger replacement PR writing through the normal `create-job`
and `dispatch` path. Put the maintainer decision in the prompt:

```md
Treat #123 as useful source work. If the source branch cannot be safely updated
because it is uneditable, stale, draft-only, unmergeable, or unsafe, create a
narrow Clownfish replacement PR instead of waiting. Preserve the source PR
author as co-author, credit the source PR in the replacement PR body, and close
only that source PR after the replacement PR is opened.
```

The worker should emit `repair_strategy=replace_uneditable_branch` and list the
source PR URL in `source_prs`. The deterministic executor opens or updates
`clownfish/<cluster-id>`, adds non-bot source PR authors as `Co-authored-by`
trailers, and closes the superseded source PR only after the replacement PR
exists. New replacement PRs are blocked when the touched area already has
`CLOWNFISH_MAX_ACTIVE_PRS_PER_AREA` open Clownfish PRs.

## Validate And Dispatch

```bash
npm run validate:job -- jobs/openclaw/inbox/clawsweeper-openclaw-openclaw-123.md
npm run render -- jobs/openclaw/inbox/clawsweeper-openclaw-openclaw-123.md --mode autonomous >/tmp/clownfish-rendered-prompt.md
git add jobs/openclaw/inbox/clawsweeper-openclaw-openclaw-123.md
git commit -m "chore: add ClawSweeper promoted job"
git push origin main
npm run dispatch -- jobs/openclaw/inbox/clawsweeper-openclaw-openclaw-123.md \
  --mode autonomous \
  --runner blacksmith-4vcpu-ubuntu-2404 \
  --execution-runner blacksmith-16vcpu-ubuntu-2404 \
  --model gpt-5.5
```

Do not use `--dispatch` until the job is committed and pushed; the workflow
reads the job path from GitHub. Execute/fix gates are closed unless the repo
variables are literally `1`; open them only for the execution window:

```bash
gh variable set CLOWNFISH_ALLOW_EXECUTE --repo openclaw/clownfish --body 1
gh variable set CLOWNFISH_ALLOW_FIX_PR --repo openclaw/clownfish --body 1
gh variable set CLOWNFISH_ALLOW_MERGE --repo openclaw/clownfish --body 0
```

Reset `CLOWNFISH_ALLOW_EXECUTE=0` and `CLOWNFISH_ALLOW_FIX_PR=0` after the
window. Keep `CLOWNFISH_ALLOW_MERGE=0` unless Peter explicitly opens the merge
gate.

## Maintainer Comment Commands

Clownfish can also be asked from target repo comments, but only by maintainers.
Use `/clownfish ...` or `@openclaw-clownfish ...`; do not use `@clownfish`
because that is a separate GitHub user.

Supported commands:

```text
/clownfish status
/clownfish fix ci
/clownfish address review
/clownfish rebase
/clownfish explain
/clownfish stop
@openclaw-clownfish fix ci
```

The router accepts `OWNER`, `MEMBER`, and `COLLABORATOR` comments by default.
Contributor comments are ignored without a reply. Repair commands dispatch
`cluster-worker.yml` only for existing Clownfish PRs with the `clownfish` label
or `clownfish/*` branch.

```bash
npm run comment-router -- --repo openclaw/openclaw --lookback-minutes 180
npm run comment-router -- --repo openclaw/openclaw --execute --wait-for-capacity
```

Scheduled routing stays dry until `CLOWNFISH_COMMENT_ROUTER_EXECUTE=1` is set in
`openclaw/clownfish` repo variables.

## Guardrails

- One cluster, one branch, one PR: `clownfish/<cluster-id>`.
- No security-sensitive work.
- New replacement PRs are capped per touched area by
  `CLOWNFISH_MAX_ACTIVE_PRS_PER_AREA`.
- Do not close duplicates before the fix PR path exists, lands, or is proven
  unnecessary.
- Codex workers do not get GitHub tokens; deterministic scripts own writes.
