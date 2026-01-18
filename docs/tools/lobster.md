---
title: Lobster
description: Typed workflow runtime for Clawdbot — composable pipelines with approval gates.
---

# Lobster

Lobster is a workflow shell that lets Clawdbot run multi-step tool sequences as a single, deterministic operation with explicit approval checkpoints.

## Why

Today, complex workflows require many back-and-forth tool calls. Each call costs tokens, and the LLM has to orchestrate every step. Lobster moves that orchestration into a typed runtime:

- **One call instead of many**: Clawdbot calls `lobster.run(...)` once and gets a structured result.
- **Approvals built in**: Side effects (send email, post comment) halt the workflow until explicitly approved.
- **Resumable**: Halted workflows return a token; approve and resume without re-running everything.

## Example: Email triage

Without Lobster:
```
User: "Check my email and draft replies"
→ clawd calls gmail.list
→ LLM summarizes
→ User: "draft replies to #2 and #5"
→ LLM drafts
→ User: "send #2"
→ clawd calls gmail.send
(repeat daily, no memory of what was triaged)
```

With Lobster:
```
clawd calls: lobster.run("email.triage --limit 20")

Returns:
{
  "status": "needs_approval",
  "output": {
    "summary": "5 need replies, 2 need action",
    "drafts": [...]
  },
  "requiresApproval": {
    "prompt": "Send 2 draft replies?",
    "resumeToken": "..."
  }
}

User approves → clawd calls: lobster.resume(token, approve: true)
→ Emails sent
```

One workflow. Deterministic. Safe.

## Enable

Lobster is an **optional** plugin tool. Enable it in your agent config:

```json
{
  "agents": {
    "list": [{
      "id": "main",
      "tools": {
        "allow": ["lobster"]
      }
    }]
  }
}
```

You also need the `lobster` CLI installed locally.

## Actions

### `run`

Execute a Lobster pipeline in tool mode.

```json
{
  "action": "run",
  "pipeline": "gog.gmail.search --query 'newer_than:1d' | email.triage",
  "timeoutMs": 30000
}
```

### `resume`

Continue a halted workflow after approval.

```json
{
  "action": "resume",
  "token": "<resumeToken>",
  "approve": true
}
```

## Security

- **Local subprocess only** — no network calls from the plugin itself.
- **No secrets** — Lobster doesn't manage OAuth; it calls clawd tools that do.
- **Sandbox-aware** — disabled when `ctx.sandboxed` is true.
- **Hardened** — `lobsterPath` must be absolute if specified; timeouts and output caps enforced.

## Learn more

- [Lobster repo](https://github.com/vignesh07/lobster) — runtime, commands, and workflow examples.
