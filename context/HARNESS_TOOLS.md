# Harness Tools

These scripts turn the workspace protocol into runnable helpers.

## Main CLI

`scripts/openclaw_harness.py`

Subcommands:

- `session-context`: load context in bootstrap order
- `route`: triage a request to `coordinator` / `general-purpose` / `Explore` / `Plan` / `Verification`
- `orchestrate-task`: turn a user request into a staged Claude-style execution chain
- `dispatch-bundle`: turn the staged chain into per-role handoff prompts and optional bundle files
- `dispatch-run`: initialize a staged runtime from a dispatch bundle/message
- `dispatch-update`: record one stage result and advance the next ready stage
- `dispatch-status`: inspect the latest or specified dispatch run
- `dispatch-rewind`: rewind a dispatch run back to a given stage when a launch produced the wrong artifact
- `dispatch-bridge-status`: inspect how Claude-style roles map onto native OpenClaw agents
- `dispatch-launch`: build or execute a native `openclaw agent` command for the current ready stage
- `dispatch-sync-session`: recover a timed-out or detached native stage from session logs and advance the dispatch run
- `permission`: classify action risk as `L0` / `L1` / `L2` / `L3`
- `verify-report`: lint a completion report for verification sections
- `closure-report`: turn execution notes into a final report with verified / not verified / risks / next step
- `closeout-turn`: run `closure-report` and `auto-memory-turn` together as one session closeout step
- `closeout-session`: recover the latest real session turn and run `closeout-turn` on it while skipping heartbeat / reminder / dispatch noise by default
- `scripts/enable_auto_session_closeout_plugin.py`: enable the workspace-local `auto-session-closeout` plugin so successful user turns auto-run `closeout-session --latest-turn-only --apply --apply-memory`
  and pin the plugin directory into `plugins.load.paths` so OpenClaw treats it as an explicit trusted source
- `compact-task`: compress active task state into fixed fields
- `extract-memory`: extract facts, preferences, tasks, and URLs from conversation text
- `auto-memory-turn`: extract one turn and only apply memory when the signal is strong enough
- `recall-memory`: search layered memory files without touching legacy vector memory
- `dream-memory`: consolidate recent memory into long-term candidates without directly rewriting `MEMORY.md`
- `promote-dream`: review a dream payload and promote selected items into structured memory
- `nightly-dream-cycle`: run the nightly dream pass and structured promotion as one safe maintenance step
- `dream-cron-spec`: render the OpenClaw `cron add` command and agent message for nightly dream scheduling
- `dream-status`: inspect whether the nightly dream cron has run and what it wrote
- `verify-dream`: verify nightly dream cron state, latest snapshot, and promoted memory in one report
- `scripts/nightly_dream.sh`: safe nightly wrapper with Claude-style time/source gates
- `scripts/install_nightly_dream_cron.sh`: install or update the live OpenClaw cron job for nightly dream maintenance
- `scripts/upsert_nightly_dream_cron.py`: local store fallback when gateway cron CLI is unavailable
- `scripts/archive_stale_weixin_queue.py`: archive stale failed Weixin queue items so they do not replay later

## Examples

```bash
python3 scripts/openclaw_harness.py session-context --mode main
python3 scripts/openclaw_harness.py route --message "帮我验证配置修改有没有成功"
python3 scripts/openclaw_harness.py orchestrate-task --message "继续优化 OpenClaw harness，并且把 nightly dream 和验证链接起来"
python3 scripts/openclaw_harness.py dispatch-bundle --message "继续优化 OpenClaw harness，并且把 nightly dream 和验证链接起来"
python3 scripts/openclaw_harness.py dispatch-run --message "继续优化 OpenClaw harness，并且把 nightly dream 和验证链接起来"
python3 scripts/openclaw_harness.py dispatch-update --stage intake --text "decision: proceed to evidence"
python3 scripts/openclaw_harness.py dispatch-update --stage execution --text "what changed: ..." --apply-closeout-memory
python3 scripts/openclaw_harness.py dispatch-status
python3 scripts/openclaw_harness.py dispatch-rewind --stage evidence
python3 scripts/openclaw_harness.py dispatch-bridge-status
python3 scripts/openclaw_harness.py dispatch-launch --apply
python3 scripts/openclaw_harness.py dispatch-launch --execute --auto-update
python3 scripts/openclaw_harness.py dispatch-launch --execute --auto-update --apply-closeout-memory
python3 scripts/openclaw_harness.py dispatch-sync-session --stage execution --apply-closeout-memory
python3 scripts/openclaw_harness.py permission --text "把这篇文章发布到公众号"
python3 scripts/openclaw_harness.py verify-report --file /tmp/report.md --strict
python3 scripts/openclaw_harness.py closure-report --goal "推进 OpenClaw harness" --text "Verified: ran tests"
python3 scripts/openclaw_harness.py closeout-turn --goal "推进 OpenClaw harness" --text "Verified: ran tests"
python3 scripts/openclaw_harness.py closeout-session --agent-id main
python3 scripts/openclaw_harness.py closeout-session --agent-id main --apply
python3 scripts/openclaw_harness.py closeout-session --agent-id main --session-id 123 --latest-turn-only --apply --apply-memory --run-id run-123
python3 scripts/openclaw_harness.py compact-task
python3 scripts/openclaw_harness.py extract-memory --text "以后默认简短回复，不要官腔"
python3 scripts/openclaw_harness.py auto-memory-turn --text "以后默认简短回复，不要官腔"
python3 scripts/openclaw_harness.py recall-memory --query "OpenClaw"
python3 scripts/openclaw_harness.py dream-memory --days 7
python3 scripts/openclaw_harness.py dream-memory --days 7 --focus-current-task --min-hours 24 --min-sources 2 --respect-gates
python3 scripts/openclaw_harness.py promote-dream --max-items 3
python3 scripts/openclaw_harness.py promote-dream --max-items 3 --apply
python3 scripts/openclaw_harness.py nightly-dream-cycle --focus-current-task --apply
python3 scripts/openclaw_harness.py dream-cron-spec --focus-current-task --disabled
python3 scripts/openclaw_harness.py dream-status
python3 scripts/openclaw_harness.py verify-dream
./scripts/nightly_dream.sh
./scripts/install_nightly_dream_cron.sh
python3 scripts/archive_stale_weixin_queue.py
python3 scripts/enable_auto_session_closeout_plugin.py
```

## Memory Safety

- `extract-memory` defaults to dry-run output only
- `auto-memory-turn` is the safer day-to-day wrapper; it only applies when extracted signal count crosses a threshold
- `closeout-session` is the explicit day-to-day bridge from real session logs into the same closeout + auto-memory path used elsewhere
- when no `--session-id` / `--session-file` is given, it scans the latest few session logs and picks the newest real non-internal turn
- by default it skips internal turns such as heartbeat prompts, scheduled reminders, and dispatch stage prompts
- add `--latest-turn-only` when you want the current session's newest turn only and do not want fallback to older real turns
- add `--include-internal` only when you intentionally want to close out one of those internal turns
- add `--apply` only when the extracted result is worth keeping
- `--apply` writes to:
  - today's `memory/YYYY-MM-DD.md`
  - `memory/facts.json -> auto_memory`
  - `memory/preferences.json -> auto_memory`
- it does not rewrite `MEMORY.md`
- it does not mutate legacy `vector_memory.json`

## Dream Safety

- `dream-memory` is the safe version of a "dream" job
- default mode only summarizes candidates
- `--focus-current-task` narrows consolidation toward the active task board
- `--min-hours` and `--min-sources` approximate Claude's time/session gates
- `--respect-gates` skips the run when consolidation would be too frequent or too thin
- `--apply` writes:
  - `memory/dreams/YYYY-MM-DD.md`
  - `memory/facts.json -> dream_memory`
- it does not directly rewrite `MEMORY.md`
- the intent is nightly consolidation, not blind auto-merge

## Promotion Safety

- `promote-dream` reads the latest dream JSON snapshot
- default mode is review only
- `--apply` writes promoted items into:
  - `memory/preferences.json -> dream_promoted`
  - `memory/facts.json -> dream_promoted`
- add `--write-memory-md` only when you explicitly want a curated block appended to `MEMORY.md`

## Nightly Cycle

- `nightly-dream-cycle` is the bridge between manual dream tooling and a schedulable maintenance turn
- it evaluates the gate, writes the dream snapshot when `--apply` is set, and only then promotes structured items into memory
- if the gate is closed, it exits with a structured skipped result instead of forcing consolidation
- `scripts/nightly_dream.sh` now calls this combined cycle by default

## Cron Bridge

- `dream-cron-spec` renders a safe `openclaw cron add` command for `sessionTarget=isolated`
- the generated agent message tells the sub-agent to run `nightly-dream-cycle --apply --format json`
- default output is a preview only; it does not mutate live cron jobs
- `scripts/install_nightly_dream_cron.sh` is the mutating step that installs or updates the live job via `openclaw cron add/edit`
- if the gateway cron CLI is unavailable, it falls back to `upsert_nightly_dream_cron.py` and restarts the gateway
- it defaults to `DISABLED=1` so the job lands safely before you enable it

## Native Dispatch Bridge

- `context/AGENT_BRIDGE.json` is the compatibility layer between Claude-style roles and real OpenClaw agent ids
- current live mapping resolves `coordinator / Explore / Plan / general-purpose / Verification` to dedicated native agents
- `dispatch-bridge-status` shows the current native agent inventory and the resolved target for each role
- `dispatch-launch` takes the current `ready` stage, renders a real `openclaw agent --agent <id> --message ... --json` command, and can mark that stage `in_progress`
- when gateway auth is configured via `~/.openclaw/openclaw.json -> gateway.auth.*.source=env`, `dispatch-launch --execute` will also load matching variables from `~/.openclaw/openclaw-secrets.env`
- add `--execute` only when you want the harness to invoke the native agent directly instead of just emitting the command
- add `--auto-update` together with `--execute` when you want the harness to extract the native agent's reply and advance the next stage automatically
- use `dispatch-sync-session` when `dispatch-launch --execute --auto-update` timed out but the native agent may have already replied in session history
- approval payloads such as `/approve ...` are treated as incomplete work, not as stage results
- auto extraction now uses a reply-payload whitelist and ignores session metadata such as `sessionId` / `sessionKey`
- read-only roles now ship with explicit low-approval tool policy in the generated prompt: prefer `rg` / `sed` / `cat` / narrow diff commands, avoid `find`, `ls -la`, shell loops, and ad hoc scripting
- if auto extraction fails or you want to edit the result first, feed the stage output back manually with `dispatch-update`
- `dispatch-sync-session` reuses the same agent resolution and stale-session fallback logic as `dispatch-launch`, so a bad old role session can be bypassed without re-running the stage
- if a launch was advanced on the wrong artifact, use `dispatch-rewind --stage <id>` to restore the correct ready stage

## How To Verify Nightly Dream

- run `python3 scripts/openclaw_harness.py dream-status`
- run `python3 scripts/openclaw_harness.py verify-dream` when you want a single verification-style report
- check `next_run_at`, `recent_runs`, `dream_report`, and `dream_last_promoted_at`
- after the first automatic run, expect:
  - a new `cron/runs/<job-id>.jsonl` finished record
  - new files under `memory/dreams/`
  - updated `memory/facts.json -> dream_memory`
  - updated `memory/facts.json` / `memory/preferences.json -> dream_promoted`

## Why This Exists

These helpers operationalize the workspace rules that previously lived only in docs.

- Claude-style routing becomes a real local helper
- multi-role orchestration becomes a concrete staged handoff instead of a vague convention
- dispatch bundles turn staged orchestration into reusable handoff prompts and saved execution packets
- dispatch runs add local runtime state so stage-by-stage execution can progress instead of staying static
- execution / verification stage completion now also emits a reusable closeout object so final closeout and memory extraction can share one path
- `closeout-session` gives normal day-to-day sessions an inspectable entrypoint into that same closeout object path, even before a native runtime hook is chosen
- `scripts/enable_auto_session_closeout_plugin.py` binds that same closeout path to a native workspace plugin, so successful user-triggered `main` turns auto-close out by default
- add `--apply-closeout-memory` on `dispatch-update` when you want that closeout object to write into structured auto-memory immediately
- add `--apply-closeout-memory` on `dispatch-launch --execute --auto-update` when you want native stage completion to update the run and apply closeout memory in one step
- add `--apply-closeout-memory` on `dispatch-sync-session` when the recovered session result should also write structured closeout memory
- the native dispatch bridge connects staged runtime to real `openclaw agent` turns without assuming custom role ids already exist
- the permission layer mirrors coordinator / worker escalation more closely
- `Verification` gets a report linter for verification hygiene
- closure reporting keeps final answers aligned with verification state
- session bootstrap becomes deterministic instead of ad hoc
- memory capture and recall move toward a layered Claude-style memory flow
- dream consolidation becomes a controlled nightly memory-reflection step
