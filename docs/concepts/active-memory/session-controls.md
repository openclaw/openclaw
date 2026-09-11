---
summary: "Pause or resume active memory per session or globally, and surface its status, debug summary, and raw hidden prefix in a chat."
read_when:
  - You want to pause active memory for one conversation
  - You want to see what active memory injected
title: "Session controls"
---

## Session toggle

Pause or resume active memory for the current chat session without editing
config:

```text
/active-memory status
/active-memory off
/active-memory on
```

This only affects the current session; it does not change
`plugins.entries.active-memory.config.enabled`, an agent's
`memory.search.rememberAcrossConversations` setting, or other global
configuration.

To pause/resume for all sessions instead, use the global form (requires
owner or `operator.admin`):

```text
/active-memory status --global
/active-memory off --global
/active-memory on --global
```

The global form writes `plugins.entries.active-memory.config.enabled` but
leaves `plugins.entries.active-memory.enabled` on, so the command stays
available to turn active memory back on later.

## How to see it

By default, active memory injects a hidden untrusted prompt prefix that is
not shown in the normal reply. Turn on the session toggles that match the
output you want:

```text
/verbose on
/trace on
```

With those on, OpenClaw appends diagnostic lines after the normal reply (as a
follow-up, so channel clients do not flash a separate pre-reply bubble):

- `/verbose on` adds a status line: `🧩 Active Memory: status=ok elapsed=842ms query=recent summary=34 chars`
- `/trace on` adds a debug summary: `🔎 Active Memory Debug: Lemon pepper wings with blue cheese.`

Example flow:

```text
/verbose on
/trace on
what wings should i order?
```

```text
...normal assistant reply...

🧩 Active Memory: status=ok elapsed=842ms query=recent summary=34 chars
🔎 Active Memory Debug: Lemon pepper wings with blue cheese.
```

With `/trace raw`, the traced `Model Input (User Role)` block shows the raw
hidden prefix:

```text
Context:
<active_memory_plugin>
...
</active_memory_plugin>
```

By default the blocking sub-agent's transcript is temporary and deleted after
the run completes; see [Transcript persistence](/concepts/active-memory/advanced-options#transcript-persistence) to
keep it.
