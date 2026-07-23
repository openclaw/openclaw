---
name: coding-agent
description: "Delegate coding work to Codex, Claude Code, or OpenCode as background workers; not simple edits or read-only code lookup."
metadata:
  {
    "openclaw":
      {
        "emoji": "🧩",
        "requires":
          {
            "anyBins": ["claude", "codex", "opencode"],
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

# Coding Agent

Use for background feature builds, PR reviews, large refactors, and issue-to-PR loops. Do not use for simple edits, read-only lookup, ACP thread-bound work, or any run inside `~/.openclaw`, `$OPENCLAW_STATE_DIR`, or active OpenClaw state dirs.

## Hard rules

- Always launch with `background:true`.
- Codex and OpenCode: use `pty:true`.
- Claude Code: no PTY; use `claude --permission-mode bypassPermissions --print`.
- **Codex credential home:** never launch ambient `codex exec` against the default `~/.codex` (or an ambient process `$CODEX_HOME`) when OpenClaw also uses ChatGPT OAuth. Use a **dedicated worker `CODEX_HOME`**, authorize it once with `codex login`, preflight with `codex login status`, and scope `CODEX_HOME` only on the Codex worker command so OpenClaw keeps owning its OAuth profile. See [Codex credential isolation](#codex-credential-isolation).
- Capture a real notification route before spawning.
- Worker must send completion/failure via `openclaw message send`.
- Do not rely on heartbeat, system events, or notify-on-exit.
- Monitor with `process`; do not kill slow workers without cause.
- If user asked for a specific agent, use that agent.
- If worker fails/hangs, respawn or ask; do not silently hand-code instead.
- Never checkout branches or run background coding agents in `~/Projects/openclaw`; use an isolated checkout.
- Classify the source ref as trusted or untrusted before any checkout or worktree creation. Never materialize a contributor-controlled ref outside the repository's approved untrusted-PR sandbox/review workflow, and never launch a permission-bypassed worker in it.
- For tasks that modify a Git-backed project, prepare and verify the Git worktree before launch, then include the exact Git preparation block below in the worker prompt.

## Mandatory Git preparation

Before launching Codex, Claude Code, or OpenCode for work that modifies a Git-backed project:

1. Establish the intended target repository, then select its canonical remote. Prefer `upstream` when it exists and matches that target; otherwise verify `origin`. Resolve the selected remote's default branch dynamically. Determine the target base from an explicit task branch or authoritative existing-PR metadata; for other shared branches, prove the configured/tracked base or ask. Use the canonical default only for new work with no other specified base. Stop if the repository, remote, or target base cannot be proven.
2. Classify the source ref as trusted or untrusted before any checkout or worktree creation. For contributor-controlled refs, use the repository's approved untrusted-PR sandbox/review workflow, which must own ref materialization inside the sandbox, or stop. The remaining steps and launch forms are for trusted refs only.
3. For trusted new work, run `git fetch --prune <canonical>` immediately before creating a new isolated worktree and branch from `<canonical>/<targetBaseBranch>`.
4. For trusted new work, verify the worktree's initial `HEAD` equals the fetched target-base SHA. Record the canonical remote, canonical default branch, target base branch, base SHA, worktree path, and branch.
5. For a trusted existing PR or shared branch, fetch the canonical target base and source branch immediately before creating an isolated worktree from the fetched source branch. Record that source ref and starting SHA, report its divergence from the refreshed target base, and do not automatically rebase, merge, reset, force-push, or otherwise rewrite shared history.
6. Launch the worker in the isolated worktree, never the primary checkout. For OpenClaw, the primary checkout under `~/Projects/openclaw` remains forbidden.

For tasks that modify a Git-backed project, append this block to the worker prompt with real values:

```text
Git preparation (mandatory before edits):
- canonical remote: <canonicalRemote>
- canonical default branch: <canonicalDefaultBranch>
- target base branch: <targetBaseBranch>
- fetched target base SHA: <targetBaseSha>
- preparation mode: <new work | existing PR/shared branch>
- checkout trust: trusted
- prepared source ref: <canonicalRemote/targetBaseBranch | fetched trusted source ref>
- prepared start SHA: <preparedStartSha>
- isolated worktree: <worktreePath>
- working branch: <branch>
- preparation receipt: <new work: `git fetch --prune <canonicalRemote>` ran immediately before creation from `<canonicalRemote>/<targetBaseBranch>` | existing branch: the canonical target base and trusted source ref were fetched immediately before the worktree was created from `<preparedSourceRef>` at `<preparedStartSha>`>

Before editing, verify the current directory is the isolated worktree and its initial HEAD equals <preparedStartSha>. For new work, that SHA must equal <targetBaseSha>. Never edit the primary checkout. For existing PR/shared-branch work, report divergence and do not rebase, merge, reset, force-push, or otherwise rewrite shared history unless explicitly asked.
Immediately before the final push or PR for newly authored work, run `git fetch --prune <canonicalRemote>` and `git merge-base --is-ancestor <canonicalRemote>/<targetBaseBranch> HEAD`. If the ancestry check fails, update the new branch onto the latest target base, rerun the relevant proof, and only then push without force. For existing PR/shared-branch work, report a failed ancestry check and follow the repository workflow without rewriting the branch.
```

For trusted refs, the launcher must create and verify the worktree before starting the editing worker; do not delegate worktree creation to that worker. The approved untrusted-PR workflow must instead own checkout and worktree materialization inside its sandbox. Never start a worker in `~/Projects/openclaw`. Read-only tasks and non-project scratch work do not require the Git preparation block.

## Notification block

Append this shape to every worker prompt with real values:

```text
Notification route:
- channel: <notifyChannel>
- target: <notifyTarget>
- account: <notifyAccount or omit>
- reply_to: <notifyReplyTo or omit>
- thread_id: <notifyThreadId or omit>

When finished, send exactly one completion or failure message using:
openclaw message send --channel <channel> --target '<target>' --message '<brief result>'
Add --account, --reply-to, or --thread-id only when present above.
Do not use openclaw system event or heartbeat.
```

If no trustworthy route exists, say completion auto-notify is unavailable.

## Codex credential isolation

OpenClaw ChatGPT OAuth and the external Codex CLI both mint refresh tokens for the same provider app. Launching a coding-agent Codex worker against the ambient Codex home (`$CODEX_HOME` if already set in the process environment, otherwise `~/.codex`) can invalidate OpenClaw's stored refresh token (`refresh_token_reused` / login-expired guidance). OpenClaw remains the canonical owner of its own OAuth profile; the worker must use a **separate** Codex home. See also [OAuth](/concepts/oauth).

One-time setup (worker home only; do **not** export this into the OpenClaw gateway process):

```bash
CODEX_HOME="${CODEX_HOME_CODING_AGENT:-$HOME/.codex-coding-agent}"
mkdir -p "$CODEX_HOME"
CODEX_HOME="$CODEX_HOME" codex login
CODEX_HOME="$CODEX_HOME" codex login status   # preflight: must report logged in under this home
```

The dedicated home is a fully independent Codex profile, not only an authentication directory. It does not inherit the ambient profile's `config.toml`, profile overrides, MCP/plugin setup, skills or instructions, hooks, memories, logs, history, or sessions.

When moving an existing worker off the ambient profile:

1. Start with an empty dedicated home and run `codex login` there. Do not copy or symlink the ambient home, `auth.json`, `.credentials.json`, or platform-keyring credentials.
2. Recreate only the settings the worker needs. Review and copy known non-secret configuration, instruction, or skill files individually; configure MCP servers under the dedicated home and authorize any credential-bearing integration separately.
3. Leave logs, history, memories, and sessions behind. They are not required for the worker profile and may contain sensitive context.

Rules:

- Prefer a stable path such as `~/.codex-coding-agent` (or another dedicated directory you control).
- Set `CODEX_HOME_CODING_AGENT` when using a non-default worker home; the Codex launch forms below honor it.
- Scope `CODEX_HOME` **only** on Codex worker commands (`codex login`, `codex login status`, `codex exec`). Do not set it on the OpenClaw gateway, agent runtime, or unrelated shells that should keep using OpenClaw's auth store.
- If `codex login status` fails for the worker home, re-run `CODEX_HOME=… codex login` before spawning work. Do not fall back to ambient `~/.codex` to "just make it work."
- Claude Code and OpenCode launches are unchanged by this section; apply the isolation only to Codex CLI workers.

## Launch forms

Write the worker prompt to a temp file first. This avoids shell quoting bugs when the required notification block contains quotes or newlines.

```bash
PROMPT=$(mktemp -t openclaw-worker-prompt.XXXXXX)
cat >"$PROMPT" <<'EOF'
Task.
<mandatory Git preparation block>
<notification block>
EOF
printf 'prompt file: %s\n' "$PROMPT"
```

Use `$PROMPT` when launching from the same shell/session. If using a separate tool call, substitute the printed path. The launch forms below are for trusted checkouts only; untrusted contributor refs require the repository's approved sandbox/review workflow.

Codex (dedicated worker home — required):

```bash
# Scope CODEX_HOME only on this command (override or default worker home).
bash pty:true background:true workdir:/path/isolated-worktree command:"CODEX_HOME=\"${CODEX_HOME_CODING_AGENT:-$HOME/.codex-coding-agent}\" codex exec - < \"$PROMPT\""
```

Claude Code:

```bash
bash background:true workdir:/path/isolated-worktree command:"claude --permission-mode bypassPermissions --print < \"$PROMPT\""
```

OpenCode:

```bash
bash pty:true background:true workdir:/path/isolated-worktree command:"opencode run < \"$PROMPT\""
```

## Long issue-to-PR work

1. Create/reuse a GitHub issue as durable spec.
2. Include issue URL, repo, canonical remote/default branch, target base branch/SHA, isolated worktree, working branch, expected PR, proof, and notification route.
3. Include the mandatory Git preparation block, then tell the worker to implement, test, run review until no accepted actionable findings, and open the PR.
4. Return issue URL and `sessionId` immediately.
5. Monitor with `process`; cancel through Task Registry if mirrored there.

## Scratch Codex

Codex needs a trusted git repo. This throwaway scaffold is not project work and has no canonical remote, so the Git preparation block does not apply. Still use a **dedicated worker `CODEX_HOME`** (never ambient `~/.codex`) when OpenClaw ChatGPT OAuth is also in use:

```bash
SCRATCH=$(mktemp -d)
git -C "$SCRATCH" init
PROMPT=$(mktemp -t openclaw-worker-prompt.XXXXXX)
cat >"$PROMPT" <<'EOF'
Build X.
<notification block>
EOF
printf 'prompt file: %s\n' "$PROMPT"
bash pty:true background:true workdir:$SCRATCH command:"CODEX_HOME=\"${CODEX_HOME_CODING_AGENT:-$HOME/.codex-coding-agent}\" codex exec - < \"$PROMPT\""
```

## Process actions

- `list`: running/recent sessions.
- `poll`: status.
- `log`: output.
- `submit`: send input + Enter.
- `write`: raw stdin.
- `paste`: paste text.
- `kill`: terminate.

## Status to user

- Say what started, where, and `sessionId`.
- Update only on milestone, worker question, error, user action needed, or finish.
- If killed, say why.
