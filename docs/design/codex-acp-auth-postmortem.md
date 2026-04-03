# Codex ACP Auth Drift Postmortem

## Summary

This document records a debugging session where OpenClaw could successfully spawn a Codex ACP specialist, but the child run intermittently failed with `acpx exited with code 1`.

The core issue was not OpenClaw gateway routing, ACP spawn wiring, or Feishu channel logic. The failure came from Codex authentication state drifting between different Codex runtimes on the same machine.

## Symptoms

- `sessions_spawn` for `runtime: "acp"` returned `accepted`.
- The child Codex ACP session later showed `state: "error"` with `lastError: "acpx exited with code 1"`.
- In some earlier runs, the parent could not recover results because ACP one-shot runs were not relayed back to the parent session by default.
- Manual `codex exec "say hi and exit"` sometimes worked while OpenClaw ACP runs still failed.
- `~/.codex/auth.json` was observed flipping between:
  - `auth_mode: "chatgpt"`
  - `auth_mode: "apikey"`

## What We First Fixed

Before the auth issue was fully understood, there was a real recovery-path problem in OpenClaw:

- ACP one-shot `run` spawns did not default to parent-session relay.
- The orchestrator therefore fell back to `sessions_history + sleep` polling.

That was fixed in:

- `src/agents/acp-spawn.ts`
- `src/agents/acp-spawn.test.ts`
- `src/agents/tools/sessions-spawn-tool.ts`

After that change, ACP `run` spawns with a parent session started producing `streamLogPath` and pushing lifecycle updates back to the parent session by default.

This fix was correct, but it exposed a deeper problem: the Codex child itself was still failing.

## Root Cause

The machine had two materially different Codex runtimes:

1. Global CLI installed via npm:
   - for example, `codex` on `$PATH`
2. Codex Desktop bundled runtime:
   - for example, the app-bundled `codex` binary on macOS

At one point they disagreed about auth state:

- Global CLI could be repaired into `Logged in using ChatGPT`
- Desktop bundled `codex` still reported `Logged in using an API key`

That distinction mattered because OpenClaw ACP debugging repeatedly intersected with the Desktop runtime and its background process chain, especially:

- `Codex.app`
- `codex app-server`

When `~/.codex/auth.json` was in API key mode, ACP child runs failed and eventually surfaced as:

- `acpx exited with code 1`

The practical root cause was:

- `~/.codex/auth.json` was not stably persisted in ChatGPT auth mode.
- A Codex Desktop runtime path was still operating against API-key auth state.
- OpenClaw ACP runs then inherited or observed the wrong auth state and failed.

## What We Ruled Out

The debugging session established several negative findings with high confidence.

### Not the OpenClaw gateway

Restarting or not restarting the gateway was not the key variable for the auth failure.

The issue reproduced independently of gateway lifecycle and lived below OpenClaw, inside Codex runtime/auth state.

### Not ACP spawn wiring

ACP spawn itself was functional once configuration was corrected:

- `runtime: "acp"`
- `agentId: "codex"`
- cross-agent visibility enabled
- parent relay default added for ACP one-shot runs

We observed successful ACP acceptance and parent stream relay setup.

### Not `acpx` or `codex-acp` rewriting `auth.json`

A controlled experiment was run:

- continuously monitor `~/.codex/auth.json`
- in parallel run:
  - `./extensions/acpx/node_modules/.bin/acpx --verbose --cwd ~/.openclaw/workspace codex exec "say hi and exit"`

During that ACP execution window, `auth.json` did not change at all.

This is important: it means the specialist runtime path was not the component actively rewriting the auth file during that reproduction.

## Strongest Evidence

The most useful evidence from the incident:

1. `~/.codex/auth.json` was observed in bad state:

```json
{
  "auth_mode": "apikey",
  "OPENAI_API_KEY": "sk-proj-..."
}
```

2. The bundled Desktop Codex binary explicitly confirmed the wrong mode:

```bash
<desktop-codex-binary> login status
```

Output at the time:

```text
Logged in using an API key
```

3. Later, after a clean relogin, both binaries agreed on the repaired state:

```bash
codex login status
<desktop-codex-binary> login status
```

Output:

```text
Logged in using ChatGPT
```

4. Once both runtimes agreed and `auth.json` stayed as ChatGPT auth, ACP execution recovered.

## Recovery Procedure That Worked

The most reliable recovery path was:

```bash
codex logout
codex login
codex login status
```

Then verify both runtimes, not just one:

```bash
codex login status
<desktop-codex-binary> login status
sed -n '1,20p' ~/.codex/auth.json
```

Healthy state:

- both `login status` commands say `Logged in using ChatGPT`
- `~/.codex/auth.json` contains:
  - `"auth_mode": "chatgpt"`
  - `"OPENAI_API_KEY": null`

Finally, verify ACP directly:

```bash
cd <openclaw-workspace>
./extensions/acpx/node_modules/.bin/acpx --verbose --cwd <openclaw-agent-workspace> codex exec "say hi and exit"
```

If this returns `hi`, the ACP runtime is healthy again.

## Operational Lessons

### 1. Separate OpenClaw failures from Codex failures

When Codex ACP tasks fail, first determine which layer is broken:

- OpenClaw orchestration
- ACP runtime bridge
- Codex runtime
- Codex auth

Do not assume a gateway restart will help.

### 2. Always validate both Codex binaries

This machine can have two effective Codex runtimes:

- npm-installed global CLI
- Desktop-bundled CLI

A fix applied to one is not enough if the other still carries stale auth state.

### 3. `accepted` is not success

For ACP tasks:

- `sessions_spawn(... runtime: "acp") -> accepted` only means dispatch succeeded
- child runtime success still needs to be verified separately

### 4. Parent relay and child health are separate concerns

Two different bugs coexisted:

- parent could not recover results by default
- child runtime auth could still fail

Fixing one exposed the other.

## Recommended Checklist For Future Incidents

When a Codex ACP task fails:

1. Check current auth mode:

```bash
codex login status
<desktop-codex-binary> login status
```

2. Inspect auth file:

```bash
sed -n '1,20p' ~/.codex/auth.json
```

3. Validate direct Codex execution:

```bash
cd <openclaw-workspace>
codex exec "say hi and exit"
```

4. Validate ACP without OpenClaw parent orchestration:

```bash
./extensions/acpx/node_modules/.bin/acpx --verbose --cwd <openclaw-agent-workspace> codex exec "say hi and exit"
```

5. Only after those checks, decide whether OpenClaw itself is implicated.

## Current Status

At the end of this debugging session:

- ACP parent relay default for one-shot `run` spawns was fixed in OpenClaw.
- Codex auth was repaired back to ChatGPT mode.
- Both global CLI and Desktop bundled CLI agreed on ChatGPT auth.
- `auth.json` remained stable during direct ACP execution tests.

The unresolved narrow question is not "is OpenClaw broken?" anymore.

The remaining long-tail question is:

- under what exact Desktop lifecycle event did Codex previously revert `~/.codex/auth.json` back to API-key mode?

The most likely ownership remains the Codex Desktop runtime path rather than OpenClaw, but that specific write event was not captured at the exact moment it happened.
