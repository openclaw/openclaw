# 2026-03-13 Codex ACP Runtime Recovery

## Scope

- Recover the real OpenClaw -> ACP -> Codex specialist path.
- Separate repository bugs from local machine auth and network environment
  issues.
- Verify the path with a real OpenClaw task instead of only a toy `hi`
  prompt.

## Initial Symptoms

- `sessions_spawn` with `runtime: "acp"` returned `accepted`, but the child
  Codex run often failed or stalled later.
- Earlier failures surfaced as:
  - `acpx exited with code 1`
- Later failures changed shape:
  - the child session stayed `running`
  - parent stream logs showed:
    - `codex has produced no output for 60s. It may be waiting for interactive input.`
- Manual `codex exec "say hi and exit"` and manual `acpx ... codex exec`
  sometimes worked while the real OpenClaw task still failed.

## What Was Actually Broken

This incident was not a single bug. It was a chain of separate issues:

1. OpenClaw was preserving stale provider API keys in generated `models.json`.
2. Codex ACP sessions defaulted to `read-only` unless a runtime mode was
   applied explicitly.
3. The local machine had a runtime-environment difference between:
   - manual repro commands run in a shell with proxy variables
   - gateway-launched Codex ACP child processes run with proxy variables unset

All three had to be understood before the real path recovered.

## Fix 1: Stop Preserving Stale Provider API Keys

### Symptom

- `~/.openclaw/openclaw.json` had already been cleared of OpenAI API keys.
- But generated agent `models.json` still preserved an older plaintext
  `openai.apiKey`.
- Codex auth could drift back to API-key mode even after switching to
  ChatGPT login.

### Root Cause

`models.mode: "merge"` merged existing provider secrets from prior
`models.json` output even when the current config had explicitly stopped
providing an API key.

The bad behavior was:

- current config updated the provider
- old generated `models.json` still had a plaintext key
- merge logic preserved the old plaintext key
- downstream runtimes kept seeing the stale provider secret

### Repo Fix

Commit:

- `afb5b10da` `Agents: drop stale merged provider api keys`

Files:

- `src/agents/models-config.merge.ts`
- `src/agents/models-config.plan.ts`
- `src/agents/models-config.merge.test.ts`
- `src/agents/models-config.fills-missing-provider-apikey-from-env-var.test.ts`

### Result

- Explicitly configured providers now treat current config as authoritative.
- Old plaintext provider keys are no longer silently reintroduced from a stale
  generated `models.json`.

## Fix 2: Default Codex ACP Runtime Mode To `auto`

### Symptom

- Codex ACP sessions were created successfully.
- But Codex ACP sessions defaulted to `read-only`.
- Some Codex ACP runs either failed immediately or degraded into the wrong
  runtime behavior unless mode was manually switched.

### Root Cause

Codex ACP needs a writable/default agent mode for real coding-task turns.
OpenClaw was not applying a default `runtimeMode` for Codex ACP sessions, so
they inherited the backend default.

### Repo Fix

Commit:

- `731cae47d` `ACP: default Codex runtime mode to auto`

Files:

- `src/acp/control-plane/runtime-options.ts`
- `src/acp/control-plane/manager.core.ts`
- `src/acp/control-plane/manager.test.ts`

### Result

- Codex ACP sessions now default to `runtimeMode: "auto"` when no explicit
  runtime mode is set.
- This removed the need to manually repair each Codex ACP session mode.

## The Final Remaining Blocker Was Not A Repo Bug

After both repo fixes landed, the real OpenClaw task still did not fully
recover. At that stage the failure pattern had changed:

- auth stayed healthy as `Logged in using ChatGPT`
- the child session got created
- `runtimeMode: "auto"` was present
- but the child run sometimes stalled with no output

This pointed away from config merge and runtime mode, and toward process
environment.

## High-Confidence Environment Finding

The decisive A/B test was:

### Proxy-enabled environment

Running the same Codex ACP `prompt --session` flow with the same task text in a
shell that still had proxy variables worked.

That path produced:

- `session/prompt`
- streamed `agent_message_chunk` updates
- `stopReason: "end_turn"`

### Proxy-cleared environment

Running the same flow with these variables removed:

- `HTTP_PROXY`
- `HTTPS_PROXY`
- `ALL_PROXY`
- lowercase variants

caused the prompt flow to hang in the same way the gateway-launched task did.

That path showed:

- ACP session created
- `last_prompt_at` updated
- no assistant messages
- no completion
- prompt process stayed alive

### Why This Mattered

The gateway had been launched with:

```bash
unset HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy
pnpm openclaw gateway
```

So the real OpenClaw child processes inherited a different environment from the
manual successful repro commands.

## Final Recovery

The path recovered after:

1. keeping Codex auth in ChatGPT mode
2. removing the stale merged provider-key behavior
3. defaulting Codex ACP runtime mode to `auto`
4. launching the gateway without stripping proxy variables

The successful gateway command was simply:

```bash
cd /Users/wuji/Documents/openclaw && pnpm openclaw gateway
```

with proxy variables still present in the shell environment.

## Final Real-Task Verification

The real OpenClaw task used for final verification was:

- “调用 Codex 分析一下 self-improving skill，给我 3 条建议。”

The successful child run showed:

- continuous `assistant_delta`
- `lifecycle end`
- `codex run completed.`

This was the first full end-to-end confirmation that the real
OpenClaw -> ACP -> Codex specialist path had recovered.

## What We Learned

### 1. This incident contained both product bugs and machine-state bugs

Two real repo bugs existed:

- stale merged provider API keys
- missing default Codex ACP runtime mode

But fixing them still would not have recovered the real path while the gateway
continued to launch Codex ACP children in the wrong network environment.

### 2. Manual success is not enough unless the environment matches the gateway

It is not enough to prove:

- `codex exec ...` works
- `acpx ... codex exec ...` works

The repro must match the gateway child environment, especially:

- auth mode
- working directory
- proxy variables

### 3. The remaining failure mode changed after each fix

The debugging process only became clear after separating failures by phase:

- auth drift and stale secrets
- read-only session mode
- no-output stall under no-proxy child environment

Each fix exposed the next bottleneck.

## Recommended Checklist

When Codex ACP breaks again:

1. Verify Codex auth:
   - `codex login status`
   - Desktop-bundled Codex login status if relevant
2. Check that generated agent `models.json` is not reintroducing a stale
   plaintext provider key.
3. Confirm the Codex ACP session runtime mode is `auto`.
4. Compare gateway environment vs manual repro environment:
   - especially proxy variables
5. Reproduce with the same:
   - task text
   - session flow
   - cwd
   - auth mode
   - proxy environment

## Artifacts

Key related documents:

- `docs/design/codex-acp-auth-postmortem.md`
- `docs/design/codex-orchestrator-specialist.md`

Key related code changes:

- `src/agents/models-config.merge.ts`
- `src/agents/models-config.plan.ts`
- `src/acp/control-plane/runtime-options.ts`
- `src/acp/control-plane/manager.core.ts`
