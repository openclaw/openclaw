# Claude CLI tmux transport and managed hooks spec

## Purpose

Replace the current `claude -p --output-format stream-json --bare` integration with a long-lived interactive Claude Code session controlled through tmux. The new path must keep OpenClaw's existing run-level API stable, preserve streaming assistant output, provide reliable turn-completion signals, and continue to disable Claude Code memory without using `--bare`.

## Background

Current Claude CLI backend behavior is defined in `extensions/anthropic/cli-backend.ts`:

```text
claude -p --output-format stream-json --include-partial-messages --verbose --bare --setting-sources user --dangerously-skip-permissions
```

This has three important properties:

- `-p` / `--print` gives JSONL streaming output that `src/agents/cli-output.ts` already parses.
- `--bare` disables Claude Code memory, but also disables hooks, LSP, plugin sync, attribution, background prefetches, keychain reads, and `CLAUDE.md` auto-discovery.
- `--bare` is currently used to disable Claude Code's own memory, not because OpenClaw requires the rest of minimal mode.

Claude Code `2.1.136` contains narrower memory controls:

- `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` disables auto-memory.
- `autoMemoryEnabled:false` disables reading and writing the auto-memory directory.
- `autoDreamEnabled:false` disables background memory consolidation.
- `claudeMdExcludes` can exclude user/project/local `CLAUDE.md` and `.claude/rules` files.
- `--append-system-prompt-file` exists and can be used outside print mode.
- `--managed-settings` exists as a hidden SDK/parent-process flag and can inject policy-tier hooks.

Therefore the replacement should not be `tmux + --bare`. It should be `tmux + non-bare + managed-disabled-memory + OpenClaw-owned hook side channel`.

## Goals

- Remove the dependency on `claude -p` for the primary Claude CLI path.
- Do not use `--bare` in tmux mode.
- Disable Claude Code memory with explicit memory controls.
- Preserve or restore reliable turn-end detection using Claude Code hooks.
- Keep `runCliAgent` and existing callback semantics stable for callers.
- Keep the legacy child-process path available during rollout.
- Allow a config or env flag to opt in to tmux mode before making it the default.
- Avoid relying on user Claude hooks, user Claude plugins, or project `.claude/settings.json` by default.

## Non-goals

- Do not parse Claude Code private session databases or undocumented state files.
- Do not use `tmux capture-pane` as the primary streaming source.
- Do not make user Claude login state the default auth source for unattended OpenClaw runs.
- Do not try to exactly reproduce every `stream-json` event from the interactive terminal UI. Hook events provide lifecycle/tool structure; terminal output provides best-effort assistant text streaming.

## High-level architecture

The tmux transport has four cooperating pieces:

1. Session manager
   - Creates, reuses, health-checks, and kills tmux sessions.
   - Starts Claude Code in interactive mode with OpenClaw-managed settings.
   - Passes OpenClaw-managed environment through tmux without writing secrets to disk.
   - Pipes pane output to a runtime log file.

2. Prompt sender
   - Writes prompt text to a file.
   - Loads it into a tmux paste buffer.
   - Pastes it into Claude's input pane and submits it.

3. Hook side channel
   - Injects managed Claude Code hooks.
   - Hook commands write JSONL events to an OpenClaw runtime file.
   - `Stop` events are the primary turn-completion signal.

4. Terminal stream parser
   - Tails tmux `pipe-pane` output.
   - Strips terminal control sequences and UI chrome.
   - Emits assistant text deltas as best-effort streaming output.
   - Provides idle/prompt-ready fallback completion if hooks are unavailable.

## Config model

Add an execution mode to `CliBackendConfig` in `src/config/types.agent-defaults.ts`.

```ts
export type CliBackendConfig = {
  // Existing fields...
  execution?: CliExecutionConfig;
};

export type CliExecutionConfig =
  | {
      mode?: "child";
    }
  | {
      mode: "tmux";
      tmux?: CliTmuxExecutionConfig;
    };

export type CliTmuxExecutionConfig = {
  sessionNamePrefix?: string;
  runtimeDir?: string;
  startupTimeoutMs?: number;
  turnTimeoutMs?: number;
  turnIdleMs?: number;
  captureLines?: number;
  stopOnAbort?: boolean;
  memoryMode?: "managed-disabled" | "bare";
  hookMode?: "managed" | "off";
  authMode?: "openclaw" | "user-claude";
};
```

Default behavior remains child-process mode:

```json
{
  "execution": {
    "mode": "child"
  }
}
```

A Claude tmux opt-in config should look like:

```json
{
  "agentDefaults": {
    "cliBackends": {
      "claude-cli": {
        "execution": {
          "mode": "tmux",
          "tmux": {
            "memoryMode": "managed-disabled",
            "hookMode": "managed",
            "turnTimeoutMs": 900000,
            "turnIdleMs": 1200,
            "authMode": "openclaw"
          }
        }
      }
    }
  }
}
```

If the current config schema for `cliBackends` remains a loose record, the first implementation can update only TypeScript types and runtime validation. If this becomes a public configuration surface, update schema/help/docs in the same change.

## Claude startup command

Tmux mode must not reuse the child-mode args directly. It must build Claude-specific interactive args.

Forbidden in tmux mode:

```text
-p
--print
--output-format stream-json
--include-partial-messages
--bare
```

Recommended startup shape:

```bash
CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 claude \
  --managed-settings '<json>' \
  --settings '<settings-file-or-json>' \
  --setting-sources '' \
  --append-system-prompt-file '<system-prompt-file>' \
  --permission-mode bypassPermissions \
  --model '<model>'
```

Notes:

- `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` is the primary memory-disable guard.
- `--settings` carries session-local defensive settings.
- `--managed-settings` carries OpenClaw-owned hooks and restrictive policy-like settings.
- `--setting-sources ''` disables user/project/local settings while retaining flag/policy settings.
- `--append-system-prompt-file` preserves the current append-system-prompt behavior without oversized argv.
- If the system prompt hash changes, rebuild the tmux session instead of trying to patch a running interactive session.

## Claude settings

Write a per-session settings file in the tmux runtime directory.

Minimum settings:

```json
{
  "autoMemoryEnabled": false,
  "autoDreamEnabled": false,
  "claudeMdExcludes": ["**/CLAUDE.md", "**/.claude/rules/**"],
  "disableBackgroundAgents": true,
  "disableRemoteControl": true
}
```

Managed settings should include hook isolation:

```json
{
  "autoMemoryEnabled": false,
  "autoDreamEnabled": false,
  "allowManagedHooksOnly": true,
  "disableBackgroundAgents": true,
  "disableRemoteControl": true,
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node <openclaw-hook-writer> SessionStart",
            "timeout": 5,
            "suppressOutput": true
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node <openclaw-hook-writer> UserPromptSubmit",
            "timeout": 5,
            "suppressOutput": true
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "node <openclaw-hook-writer> PreToolUse",
            "timeout": 5,
            "suppressOutput": true
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "node <openclaw-hook-writer> PostToolUse",
            "timeout": 5,
            "suppressOutput": true
          }
        ]
      }
    ],
    "PostToolUseFailure": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "node <openclaw-hook-writer> PostToolUseFailure",
            "timeout": 5,
            "suppressOutput": true
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node <openclaw-hook-writer> Stop",
            "timeout": 10,
            "suppressOutput": true
          }
        ]
      }
    ]
  }
}
```

The implementation must not hard-code `<openclaw-hook-writer>` inside the settings template. It must write a hook writer script to the runtime directory and inject its absolute path when building managed settings.

## Auth model

Non-bare Claude Code can read keychains and config roots. This must be explicit.

Supported `authMode` values:

1. `openclaw`
   - Default and recommended.
   - Use OpenClaw-resolved provider auth.
   - Clear inherited Claude auth/config env first.
   - Set an OpenClaw-owned `CLAUDE_CONFIG_DIR`, or otherwise provide credentials through an OpenClaw-controlled helper/fd/env.
   - Do not depend on user Claude login state.

2. `user-claude`
   - Development/compatibility mode.
   - Allows Claude Code to use the user's existing login/keychain/config.
   - Must not become the unattended gateway default.

`extensions/anthropic/cli-shared.ts` currently clears `CLAUDE_CONFIG_DIR`. Tmux mode needs a mode-aware env builder:

- child/bare path: keep clearing inherited `CLAUDE_CONFIG_DIR`.
- tmux/openclaw path: clear inherited values, then set an OpenClaw-owned `CLAUDE_CONFIG_DIR`.
- tmux/user-claude path: clear explicit inherited overrides only if they would steer Claude to an unexpected custom config tree; allow the default user config behavior.

## Runtime directory

Each tmux Claude session gets a runtime directory.

Recommended layout:

```text
claude-tmux/
  <session-key-hash>/
    active-run.json
    events.jsonl
    pane.log
    managed-settings.json
    settings.json
    system-prompt.txt
    hook-writer.mjs
    launch-claude.mjs
    prompt-buffer.txt
    metadata.json
```

`metadata.json`:

```json
{
  "backendId": "claude-cli",
  "workspaceDir": "...",
  "sessionName": "openclaw-claude-...",
  "launchHash": "...",
  "model": "sonnet",
  "systemPromptHash": "...",
  "mcpConfigHash": "...",
  "authProfileId": "...",
  "createdAt": 1760000000000,
  "lastUsedAt": 1760000000000
}
```

`active-run.json` is updated before each prompt is submitted:

```json
{
  "runId": "...",
  "openclawSessionId": "...",
  "cliSessionId": "...",
  "startedAt": 1760000000000,
  "promptHash": "...",
  "turnIndex": 12
}
```

Hook writer output format in `events.jsonl`:

```json
{
  "event": "Stop",
  "runId": "...",
  "openclawSessionId": "...",
  "claudeSessionId": "...",
  "timestamp": 1760000000000,
  "stdin": {
    "session_id": "...",
    "hook_event_name": "Stop"
  }
}
```

This run association is required because Claude Code may emit `Stop` for clear, resume, compaction, and other internal transitions.

## tmux session identity and reuse

Session names must be stable and safe.

Hash inputs:

- backend id
- workspace realpath
- OpenClaw session key
- auth profile id or auth epoch
- model id
- system prompt hash
- MCP config hash
- memory mode
- hook mode

Default name:

```text
openclaw-claude-<12-char-hash>
```

Reuse requires all of the following:

- tmux session exists.
- `metadata.json` exists.
- metadata matches the current workspace/model/system prompt/MCP/auth/memory/hook inputs.
- launch hash matches the current command, args, managed settings, and OpenClaw-managed env.
- pane process is alive.
- startup or ready signal is healthy.

Rebuild the tmux session when any of these change:

- system prompt hash
- MCP config hash
- auth epoch/profile
- Claude executable path or version
- managed settings hash
- launch hash
- memory mode
- hook mode
- explicit user reset
- health check failure

## tmux commands

Use argv-based process execution. Do not build shell command strings except where tmux itself requires a shell command for `pipe-pane` or hook command execution.

Core commands:

```bash
tmux has-session -t <session>
tmux new-session -d -e KEY=value -s <session> -c <workspace> -- node <launch-claude.mjs>
tmux pipe-pane -o -t <session>:0.0 'cat >> <pane.log>'
tmux load-buffer -b <buffer-name> <prompt-buffer.txt>
tmux paste-buffer -b <buffer-name> -t <session>:0.0
tmux send-keys -t <session>:0.0 Enter
tmux capture-pane -p -J -S -<lines> -t <session>:0.0
tmux kill-session -t <session>
```

`pipe-pane` is the primary terminal-output stream. `capture-pane` is diagnostic/recovery only.

OpenClaw-managed env values are passed with `tmux new-session -e` so secrets do not get written to `launch-claude.mjs`, metadata, or runtime logs. This still exposes secrets briefly in the local tmux client argv during session creation; replacing that with an fd/pipe handoff is a future hardening option if local same-user process argv visibility becomes unacceptable.

## Prompt submission

Prompt submission flow:

1. Write `active-run.json`.
2. Write prompt text to `prompt-buffer.txt`.
3. `tmux load-buffer` from that file.
4. `tmux paste-buffer` into the Claude pane.
5. `tmux send-keys Enter` to submit.

Do not send long prompts with repeated `send-keys` calls.

Optional prompt wrapper:

```text
<openclaw-run id="<runId>">
<user-message>
...
</user-message>
</openclaw-run>
```

Do not rely on this wrapper being echoed for completion detection. Completion detection is hook-based.

## Runner integration

`src/agents/cli-runner/execute.ts` should branch by execution mode:

```ts
if (backend.execution?.mode === "tmux") {
  return executeTmuxCliWithSession(...);
}

return executeChildCliWithSession(...);
```

The current child logic should be split out rather than embedding tmux logic inside the existing long function.

Suggested modules:

```text
src/agents/cli-runner/tmux/types.ts
src/agents/cli-runner/tmux/session-name.ts
src/agents/cli-runner/tmux/runtime-dir.ts
src/agents/cli-runner/tmux/hooks.ts
src/agents/cli-runner/tmux/manager.ts
src/agents/cli-runner/tmux/terminal-stream.ts
src/agents/cli-runner/tmux/execute.ts
```

Shared code should remain in existing helpers where possible:

- system prompt building
- model/session id resolution
- env sanitization
- timeout/failover wrapping
- final `CliOutput` construction

## Output and event mapping

Child mode continues to use `createCliJsonlStreamingParser`.

Tmux mode uses two inputs:

1. terminal bytes from `pane.log`
2. hook events from `events.jsonl`

Terminal parser responsibilities:

- strip ANSI/OSC/cursor controls
- remove prompt echo
- remove Claude UI chrome such as input boxes, spinners, and status lines
- deduplicate rewritten terminal output
- emit assistant text deltas via `onAssistantTurn`
- avoid fabricating thinking deltas when interactive output does not expose them reliably

Hook event mapping:

- `SessionStart`
  - call `onSystemInit({ subtype: "init", sessionId })`
- `UserPromptSubmit`
  - mark the prompt as accepted by Claude
- `PreToolUse`
  - call `onToolUseEvent({ name, toolUseId, input })`
- `PostToolUse`
  - call `onToolResult({ toolUseId, text, isError: false })`
- `PostToolUseFailure`
  - call `onToolResult({ toolUseId, text, isError: true })`
- `Stop`
  - complete the current run if it matches the active `runId`

## Turn completion

Completion priority:

1. Current-run `Stop` hook
   - `event === "Stop"`
   - `runId === active run id`
   - `timestamp >= activeRun.startedAt`

2. Terminal idle fallback
   - recent assistant output or tool event exists
   - pane appears input-ready
   - no new terminal output for `turnIdleMs`

3. Hard timeout
   - exceed `turnTimeoutMs`
   - include `capture-pane` tail in the error context

4. Abort
   - OpenClaw abort signal fires
   - if `stopOnAbort:true`, send Ctrl-C first, then kill session if necessary

Never rely only on the last `capture-pane` screen to decide normal completion.

## Claude backend changes

`extensions/anthropic/cli-backend.ts` should keep the legacy child defaults initially. Add tmux defaults but keep `mode: "child"` until rollout.

Tmux mode must build its own Claude args. It must not reuse child args and remove a few flags opportunistically.

`extensions/anthropic/cli-shared.ts` needs mode-aware normalization:

- child mode can continue to normalize setting sources to `user`.
- tmux mode should allow `--setting-sources ''`.
- tmux mode should prefer `--permission-mode bypassPermissions` over `--dangerously-skip-permissions`.
- tmux mode should inject `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`.

## Tests

Unit tests:

```text
src/agents/cli-runner/tmux/session-name.test.ts
src/agents/cli-runner/tmux/hooks.test.ts
src/agents/cli-runner/tmux/terminal-stream.test.ts
src/agents/cli-runner/tmux/manager.test.ts
extensions/anthropic/cli-backend.test.ts
```

Coverage requirements:

- session name is stable and safe
- hash input changes force rebuild
- hook writer appends valid JSONL
- hook writer associates events with `active-run.json`
- malformed hook stdin does not crash the main runner
- tmux commands are built as argv arrays
- tmux mode args do not contain `-p`, `--bare`, `--output-format stream-json`, or `--include-partial-messages`
- tmux env contains `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`
- managed settings include `allowManagedHooksOnly:true`
- terminal parser strips ANSI/UI chrome and deduplicates redraws
- `Stop` hook completes the run
- idle fallback completes when hooks are missing
- timeout includes pane tail diagnostics
- child mode remains unchanged

Integration tests should use a fake `claude` executable inside tmux, not a real model call. The fake executable should simulate:

- startup output
- prompt receive
- assistant text output
- hook JSONL events
- tool lifecycle events
- missing `Stop` fallback
- timeout behavior

Suggested commands:

```bash
pnpm test src/agents/cli-runner/tmux
pnpm test extensions/anthropic/cli-backend.test.ts
pnpm check
```

Run `pnpm build` if the implementation touches lazy-loading or module-boundary behavior.

## Acceptance criteria

- Tmux mode starts Claude without `-p`.
- Tmux mode starts Claude without `--bare`.
- Tmux mode disables memory with `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` and settings.
- Tmux mode injects OpenClaw-managed hooks.
- Current-run `Stop` hook reliably completes a turn.
- System prompt is passed via `--append-system-prompt-file`.
- System prompt hash changes rebuild the tmux session.
- Abort does not leave the current run permanently pending.
- Legacy child mode remains functional.
- Fake tmux integration tests pass without real Claude/model calls.

## Risks and mitigations

- Claude interactive UI output may change.
  - Mitigation: turn completion depends on hooks, not terminal text.

- `--managed-settings` is hidden and could change.
  - Mitigation: isolate it in Claude-specific builders and provide hook-unavailable fallback diagnostics.

- Non-bare mode may read user keychain/config.
  - Mitigation: default to `authMode:"openclaw"` and an OpenClaw-owned config/auth path.

- User/project `CLAUDE.md` could be loaded.
  - Mitigation: use `--setting-sources ''` plus `claudeMdExcludes`.

- `Stop` can fire for compact/resume/clear.
  - Mitigation: associate events with `active-run.json` and filter by run id and timestamp.

- tmux sessions can leak.
  - Mitigation: metadata TTL, health checks, explicit cleanup, and abort kill policy.

## Implementation phases

1. Add config types and Claude tmux normalization.
2. Add runtime directory, hook writer, settings generation, and managed settings generation.
3. Add tmux manager for create/reuse/pipe/paste/kill.
4. Add hook side-channel parser and `Stop`-based turn completion.
5. Add terminal stream parser and assistant text delta emission.
6. Wire tmux execution branch into the CLI runner while keeping child mode intact.
7. Add fake Claude tmux integration tests.
8. Run real Claude manual smoke with opt-in config.
9. Decide whether to make tmux mode the default for `claude-cli`.
