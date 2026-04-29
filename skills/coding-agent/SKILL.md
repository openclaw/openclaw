---
name: coding-agent
description: 'Delegate coding tasks to Codex, Claude Code, OpenCode, or Pi agents via immediate background processes. Use when: (1) building or creating features/apps, (2) reviewing PRs in a temp clone/worktree, (3) refactoring large codebases, (4) iterative coding that needs file exploration. NOT for: simple one-line fixes (just edit), reading code (use read tool), thread-bound ACP harness requests in chat (use sessions_spawn with runtime:"acp"), or any work in ~/clawd workspace (never spawn agents here). All coding-agent runs start with background:true immediately. Claude Code: use --print --permission-mode bypassPermissions (no PTY). Codex/Pi/OpenCode: pty:true required. Parent assistant owns completion reporting: capture sessionId, use automatic completion wake/process logs, and report completion or failure itself.'
metadata:
  {
    "openclaw":
      {
        "emoji": "🧩",
        "requires":
          {
            "anyBins": ["claude", "codex", "opencode", "pi"],
            "config": ["skills.entries.coding-agent.enabled"],
          },
        "install":
          [
            {
              "id": "node-claude",
              "kind": "node",
              "package": "@anthropic-ai/claude-code",
              "bins": ["claude"],
              "label": "Install Claude Code CLI (npm)",
            },
            {
              "id": "node-codex",
              "kind": "node",
              "package": "@openai/codex",
              "bins": ["codex"],
              "label": "Install Codex CLI (npm)",
            },
          ],
      },
  }
---

# Coding Agent (always backgrounded)

Use **bash** with **background:true** for all coding-agent work.
Do not use a foreground one-shot path here.
Start the agent, capture the returned `sessionId`, monitor with `process`, and report completion or failure yourself as the parent assistant.

## ⚠️ PTY Mode: Codex/Pi/OpenCode yes, Claude Code no

For **Codex, Pi, and OpenCode**, PTY is required:

```bash
# Correct for Codex/Pi/OpenCode
bash pty:true background:true command:"codex exec 'Your prompt'"
```

For **Claude Code** (`claude` CLI), use `--print --permission-mode bypassPermissions` instead.
Do not use PTY for Claude Code here.

```bash
# Correct for Claude Code
bash background:true command:"claude --permission-mode bypassPermissions --print 'Your task'"

# Wrong for Claude Code (PTY, wrong flags, no background)
bash pty:true command:"claude --dangerously-skip-permissions 'task'"
```

### Bash Tool Parameters

| Parameter    | Type    | Description                                 |
| ------------ | ------- | ------------------------------------------- |
| `command`    | string  | The shell command to run                    |
| `pty`        | boolean | Use for Codex/Pi/OpenCode                   |
| `workdir`    | string  | Working directory                           |
| `background` | boolean | **Always true for this skill**              |
| `timeout`    | number  | Timeout in seconds                          |
| `elevated`   | boolean | Run on host instead of sandbox (if allowed) |

### Process Tool Actions

| Action      | Description                                          |
| ----------- | ---------------------------------------------------- |
| `list`      | List all running/recent sessions                     |
| `poll`      | Check if session is still running                    |
| `log`       | Get session output (with optional offset/limit)      |
| `write`     | Send raw data to stdin                               |
| `submit`    | Send data + newline (like typing and pressing Enter) |
| `send-keys` | Send key tokens or hex bytes                         |
| `paste`     | Paste text (with optional bracketed mode)            |
| `kill`      | Terminate the session                                |

---

## Mandatory Pattern

Every coding-agent run follows this pattern:

1. Start the coding CLI with `background:true` immediately.
2. Use the correct execution mode:
   - Codex/Pi/OpenCode: `pty:true`
   - Claude Code: `--print --permission-mode bypassPermissions` without PTY
3. Capture the returned `sessionId` from the background process result.
4. Tell the worker to print a clear final summary block to stdout (see template below), not to send external messages.
5. Rely on automatic completion wake if available. When woken, or when the user asks for status, use `process action:log` / `poll` to inspect the session.
6. Report completion or failure yourself from the parent assistant, using the worker's final summary and any relevant logs.
7. If automatic completion wake is unavailable or unclear, create a watchdog/check-back (cron) when appropriate, or tell the user that completion requires manual checking.

Do not pass channel IDs, account IDs, reply targets, or other routing details into worker prompts unless the user explicitly asks the worker itself to interact externally.
Do not require workers to use `openclaw message send` for completion; completion reporting belongs to the parent assistant.

---

## Worker Final Summary Block

Append instructions like this to every worker prompt:

```text
When finished, print exactly one final result block to stdout using this format:

CODING_AGENT_RESULT_START
status: success | failure | blocked
summary: <brief human-readable summary>
tests: <commands run and results, or "not run: <reason>">
changed_files:
  - <path>: <brief change>
blockers:
  - <blocker or "none">
CODING_AGENT_RESULT_END

Do not send external messages or call notification tools unless explicitly requested.
```

The parent assistant should read this block with `process action:log` and use it to compose the user-facing completion/failure report.

---

## Quick Start

For scratch Codex work, create a temp git repo first, then start the worker in the background and capture the `sessionId`:

```bash
SCRATCH=$(mktemp -d)
cd "$SCRATCH" && git init

bash pty:true workdir:$SCRATCH background:true command:"codex exec 'Your prompt here.

When finished, print exactly one final result block to stdout:
CODING_AGENT_RESULT_START
status: success | failure | blocked
summary: <brief human-readable summary>
tests: <commands run and results, or not run: reason>
changed_files:
  - <path>: <brief change>
blockers:
  - <blocker or none>
CODING_AGENT_RESULT_END

Do not send external messages unless explicitly requested.'"
```

Codex refuses to run outside a trusted git directory.
Reuse this same final-summary instruction block in every worker prompt; only the task-specific prompt body should change.

---

## Codex CLI

**Model:** `gpt-5.2-codex` is the default (set in ~/.codex/config.toml)

### Flags

| Flag            | Effect                                   |
| --------------- | ---------------------------------------- |
| `exec "prompt"` | One-shot execution inside the worker CLI |
| `--full-auto`   | Sandboxed but auto-approves in workspace |
| `--yolo`        | No sandbox, no approvals                 |

### Building/Creating

```bash
# Always background immediately
bash pty:true workdir:~/project background:true command:"codex exec --full-auto 'Build a dark mode toggle'"

# More autonomy
bash pty:true workdir:~/project background:true command:"codex --yolo 'Refactor the auth module'"
```

### Reviewing PRs

**Never review PRs in OpenClaw's own project folder.**
Clone to a temp folder or use a worktree.

```bash
REVIEW_DIR=$(mktemp -d)
git clone https://github.com/user/repo.git $REVIEW_DIR
cd $REVIEW_DIR && gh pr checkout 130

bash pty:true workdir:$REVIEW_DIR background:true command:"codex review --base origin/main"
```

Or:

```bash
git worktree add /tmp/pr-130-review pr-130-branch
bash pty:true workdir:/tmp/pr-130-review background:true command:"codex review --base main"
```

### Batch PR Reviews

```bash
git fetch origin '+refs/pull/*/head:refs/remotes/origin/pr/*'

bash pty:true workdir:~/project background:true command:"codex exec 'Review PR #86. git diff origin/main...origin/pr/86'"
bash pty:true workdir:~/project background:true command:"codex exec 'Review PR #87. git diff origin/main...origin/pr/87'"

process action:list
process action:log sessionId:XXX
```

---

## Claude Code

```bash
bash workdir:~/project background:true command:"claude --permission-mode bypassPermissions --print 'Your task'"
```

---

## OpenCode

```bash
bash pty:true workdir:~/project background:true command:"opencode run 'Your task'"
```

---

## Pi Coding Agent

```bash
# Install: npm install -g @mariozechner/pi-coding-agent
bash pty:true workdir:~/project background:true command:"pi 'Your task'"

# Non-interactive mode
bash pty:true workdir:~/project background:true command:"pi -p 'Summarize src/'"

# Different provider/model
bash pty:true workdir:~/project background:true command:"pi --provider openai --model gpt-4o-mini -p 'Your task'"
```

---

## Parallel Issue Fixing with git worktrees

```bash
git worktree add -b fix/issue-78 /tmp/issue-78 main
git worktree add -b fix/issue-99 /tmp/issue-99 main

bash pty:true workdir:/tmp/issue-78 background:true command:"pnpm install && codex --yolo 'Fix issue #78: <description>. Commit and push after review. Print the final CODING_AGENT_RESULT block to stdout.'"
bash pty:true workdir:/tmp/issue-99 background:true command:"pnpm install && codex --yolo 'Fix issue #99 from the approved ticket summary. Implement only the in-scope edits. Print the final CODING_AGENT_RESULT block to stdout.'"

process action:list
process action:log sessionId:XXX
```

---

## ⚠️ Rules

1. **Use the right execution mode per agent**:
   - Codex/Pi/OpenCode: `pty:true`
   - Claude Code: `--print --permission-mode bypassPermissions` (no PTY required)
2. **Respect tool choice** - if user asks for Codex, use Codex.
   - Orchestrator mode: do NOT hand-code patches yourself.
   - If an agent fails/hangs, respawn it or ask the user for direction, but don't silently take over.
3. **Be patient** - don't kill sessions because they're "slow"
4. **Monitor with process:log** - check progress without interfering
5. **--full-auto for building** - auto-approves changes
6. **vanilla for reviewing** - no special flags needed
7. **Parallel is OK** - run many Codex processes at once for batch work
8. **NEVER start Codex inside your OpenClaw state directory** (`$OPENCLAW_STATE_DIR`, default `~/.openclaw`) - it'll read your soul docs and get weird ideas about the org chart!
9. **NEVER checkout branches in ~/Projects/openclaw/** - that's the LIVE OpenClaw instance!
10. **Always include the final summary block instruction** in the worker prompt before spawning. The simplified examples below omit it for brevity — never spawn a worker without it.

---

## Progress Updates (Critical)

When you spawn a coding agent in the background, keep the user in the loop.

- Send 1 short message when you start: what is running, where it is running, and the captured `sessionId`.
- Update only when something changes:
  - a milestone completes
  - the worker asks a question
  - you hit an error or need user action
  - the worker finishes
- If you kill a session, immediately say you killed it and why.
- If automatic completion wake is unavailable or unclear, say whether you created a watchdog/check-back or whether the user must ask for a manual status check.

This prevents the user from seeing only a missing reply and having no idea what happened.

---

## Rules

1. **Always background immediately.**
   - Use `background:true` for every coding-agent launch.
   - Do not use the foreground one-shot path in this skill.
2. **Use the right execution mode per agent.**
   - Codex/Pi/OpenCode: `pty:true`
   - Claude Code: `--print --permission-mode bypassPermissions`
3. **Respect tool choice.**
   - If the user asked for Codex, use Codex.
   - Orchestrator mode: do not hand-code the patch yourself instead of using the requested coding agent.
4. **Capture the `sessionId` before moving on.**
   - The parent assistant uses it for `process` log/poll checks and completion reporting.
5. **Make workers report to stdout.**
   - Require a `CODING_AGENT_RESULT_START` / `CODING_AGENT_RESULT_END` final block.
   - Do not require or use `openclaw message send` for routine completion reporting.
6. **Do not silently take over.**
   - If a worker fails or hangs, respawn it or ask for direction. Do not quietly switch to hand-editing.
7. **Monitor with `process`.**
   - `process action:log` is the default low-friction check.
8. **Be patient.**
   - Do not kill sessions just because they are slow.
9. **Parallel is OK.**
   - Many background Codex sessions can run at once.
10. **Never start Codex in `~/.openclaw/`.**
11. **Never checkout branches in `~/Projects/openclaw/`.**
12. **Keep routing out of worker prompts by default.**
   - Do not pass channel/account/reply IDs unless the user explicitly asks the worker to interact externally.

---

## Learnings

- **PTY is essential** for Codex/Pi/OpenCode.
- **Git repo required**: Codex needs a trusted git directory.
- **Use `exec` under background orchestration**: short and long tasks follow the same path now.
- **`submit` vs `write`**: use `submit` to send input plus Enter.
- **Parent-owned completion reporting beats worker self-notification** for routine coding-agent delegation: capture `sessionId`, inspect stdout/logs, and report the result yourself.
