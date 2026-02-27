---
summary: "Context window + compaction: how OpenClaw keeps sessions under model limits"
read_when:
  - You want to understand auto-compaction and /compact
  - You are debugging long sessions hitting context limits
title: "Compaction"
---

# Context Window & Compaction

Every model has a **context window** (max tokens it can see). Long-running chats accumulate messages and tool results; once the window is tight, OpenClaw **compacts** older history to stay within limits.

## What compaction is

Compaction **summarizes older conversation** into a compact summary entry and keeps recent messages intact. The summary is stored in the session history, so future requests use:

- The compaction summary
- Recent messages after the compaction point

Compaction **persists** in the session’s JSONL history.

## Configuration

Use the `agents.defaults.compaction` setting in your `openclaw.json` to configure compaction behavior (mode, target tokens, etc.).
Compaction summarization preserves opaque identifiers by default (`identifierPolicy: "strict"`). You can override this with `identifierPolicy: "off"` or provide custom text with `identifierPolicy: "custom"` and `identifierInstructions`.

## Auto-compaction (default on)

When a session nears or exceeds the model’s context window, OpenClaw triggers auto-compaction and may retry the original request using the compacted context.

You’ll see:

- `🧹 Auto-compaction complete` in verbose mode
- `/status` showing `🧹 Compactions: <count>`

Before compaction, OpenClaw can run a **silent memory flush** turn to store
durable notes to disk. See [Memory](/concepts/memory) for details and config.

## Manual compaction

Use `/compact` (optionally with instructions) to force a compaction pass:

```
/compact Focus on decisions and open questions
```

## Context window source

Context window is model-specific. OpenClaw uses the model definition from the configured provider catalog to determine limits.

## Compaction vs pruning

- **Compaction**: summarises and **persists** in JSONL.
- **Session pruning**: trims old **tool results** only, **in-memory**, per request.

See [/concepts/session-pruning](/concepts/session-pruning) for pruning details.

## OpenAI server-side compaction

OpenClaw also supports OpenAI Responses server-side compaction hints for
compatible direct OpenAI models. This is separate from local OpenClaw
compaction and can run alongside it.

- Local compaction: OpenClaw summarizes and persists into session JSONL.
- Server-side compaction: OpenAI compacts context on the provider side when
  `store` + `context_management` are enabled.

See [OpenAI provider](/providers/openai) for model params and overrides.

## Post-compaction audit

After auto-compaction, OpenClaw runs a **post-compaction audit** that checks
whether the agent re-read a set of required startup files. If any are missing,
a warning is injected into the session so the agent can recover.

The audit currently fires after **auto-compaction only**. Manual `/compact`
does not trigger the audit.

The default required files are:

- `WORKFLOW_AUTO.md` (literal match)
- `memory/YYYY-MM-DD.md` (pattern match for any daily memory file)

### What is WORKFLOW_AUTO.md

`WORKFLOW_AUTO.md` is a workspace file that tells the agent **which files to
re-read after a context reset**. Because compaction replaces the full
conversation with a summary, the agent loses any instructions it loaded at the
start of the session. `WORKFLOW_AUTO.md` acts as a recovery checklist.

A typical `WORKFLOW_AUTO.md` looks like:

```md
# Post-Compaction Recovery

After context compaction, read these files in order:

1. SOUL.md
2. USER.md
3. memory/YYYY-MM-DD.md (today + yesterday)
4. HEARTBEAT.md

Resume the conversation naturally without announcing the reset.
```

Place this file in the root of your [agent workspace](/concepts/agent-workspace).

### How the audit works

1. Auto-compaction completes.
2. OpenClaw injects the "Session Startup" and "Red Lines" sections from
   `AGENTS.md` as a post-compaction context reminder.
3. On the **next agent turn**, the audit reads the session history and checks
   which files the agent accessed via the Read tool.
4. Any required file that was not read triggers a warning:

   ```
   Post-Compaction Audit: The following required startup files were not
   read after context reset:
     - WORKFLOW_AUTO.md
   Please read them now using the Read tool before continuing.
   ```

The audit is **one-shot per compaction** (it fires once, then resets) and
**best-effort** (failures are silently ignored).

## Tips

- Use `/compact` when sessions feel stale or context is bloated.
- Large tool outputs are already truncated; pruning can further reduce tool-result buildup.
- If you need a fresh slate, `/new` or `/reset` starts a new session id.
