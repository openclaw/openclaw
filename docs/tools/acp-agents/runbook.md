---
summary: "Day-to-day /acp flow from chat, ACP session lifecycle, and native Codex versus ACP routing"
title: "ACP agents operator runbook"
read_when:
  - You are operating /acp commands from chat
  - You need the ACP session lifecycle rules
  - You need to know when a request routes to native Codex instead of ACP
---

## Operator runbook

Quick `/acp` flow from chat:

<Steps>
  <Step title="Spawn">
    `/acp spawn claude --bind here`,
    `/acp spawn gemini --mode persistent --thread auto`, or explicit
    `/acp spawn codex --bind here`.
  </Step>
  <Step title="Work">
    Continue in the bound conversation or thread (or target the session key
    explicitly).
  </Step>
  <Step title="Check state">
    `/acp status`
  </Step>
  <Step title="Tune">
    `/acp model <provider/model>`, `/acp permissions <profile>`,
    `/acp timeout <seconds>`.
  </Step>
  <Step title="Steer">
    Without replacing context: `/acp steer tighten logging and continue`.
  </Step>
  <Step title="Stop">
    `/acp cancel` (current turn) or `/acp close` (session + bindings).
  </Step>
</Steps>

<AccordionGroup>
  <Accordion title="Lifecycle details">
    - Spawn creates or resumes an ACP runtime session, records ACP metadata in the OpenClaw session store, and may create a background task when the run is parent-owned.
    - Parent-owned ACP sessions are treated as background work even when the runtime session is persistent; completion and cross-surface delivery go through the parent task notifier rather than acting like a normal user-facing chat session.
    - Task maintenance closes terminal or orphaned parent-owned one-shot ACP sessions. Persistent ACP sessions are preserved while an active conversation binding remains; stale persistent sessions without an active binding are closed so they cannot be silently resumed after the owning task is done or its task record is gone.
    - Bound follow-up messages go directly to the ACP session until the binding is closed, detached, reset, or expired.
    - Gateway commands stay local. `/acp ...`, `/status`, and `/session` are never sent as normal prompt text to a bound ACP harness.
    - `cancel` aborts the active turn when the backend supports cancellation; it does not delete the binding or session metadata.
    - Turn completion waits for queued output delivery. If delivery fails, OpenClaw cancels the active turn and waits for backend cleanup before starting the next queued turn, within the configured turn timeout.
    - `close` ends the ACP session from OpenClaw's point of view and removes the binding. A harness may still keep its own upstream history if it supports resume.
    - The acpx plugin cleans up OpenClaw-owned wrapper and adapter process trees after `close`, and reaps stale OpenClaw-owned ACPX orphans during Gateway startup.
    - Idle runtime workers are eligible for cleanup after the built-in idle period; stored session metadata remains available for `/acp sessions`.

  </Accordion>
  <Accordion title="Native Codex routing rules">
    Natural-language triggers that should route to the **native Codex plugin**
    when it is enabled:

    - "Bind this Discord channel to Codex."
    - "Attach this chat to Codex thread `<id>`."
    - "Show Codex threads, then bind this one."

    Native Codex conversation binding is the default chat-control path.
    OpenClaw dynamic tools still execute through OpenClaw, while Codex-native
    tools such as shell/apply-patch execute inside Codex. For Codex-native
    tool events, OpenClaw injects a per-turn native hook relay so plugin hooks
    can block `before_tool_call`, observe `after_tool_call`, and route Codex
    `PermissionRequest` events through OpenClaw approvals. Codex `Stop` hooks
    are relayed to OpenClaw `before_agent_finalize`, where plugins can request
    one more model pass before Codex finalizes its answer. The relay stays
    deliberately conservative: it does not mutate Codex-native tool arguments
    or rewrite Codex thread records. Use explicit ACP only when you want the
    ACP runtime/session model. The embedded Codex support boundary is
    documented in the
    [Codex harness v1 support contract](/plugins/codex-harness-runtime#v1-support-contract).

  </Accordion>
  <Accordion title="Model / provider / runtime selection cheat sheet">
    - legacy Codex model refs - legacy Codex OAuth/subscription model route repaired by doctor.
    - `openai/*` - native Codex app-server embedded runtime for OpenAI agent turns.
    - `/codex ...` - native Codex conversation control.
    - `/acp ...` or `runtime: "acp"` - explicit ACP/acpx control.

  </Accordion>
  <Accordion title="ACP-routing natural-language triggers">
    Triggers that should route to the ACP runtime:

    - "Run this as a one-shot Claude Code ACP session and summarize the result."
    - "Use Gemini CLI for this task in a thread, then keep follow-ups in that same thread."
    - "Run Codex through ACP in a background thread."

    OpenClaw picks `runtime: "acp"`, resolves the harness `agentId`, binds to
    the current conversation or thread when supported, and routes follow-ups
    to that session until close/expiry. Codex only follows this path when
    ACP/acpx is explicit or the native Codex plugin is unavailable for the
    requested operation.

    For `sessions_spawn`, `runtime: "acp"` is advertised only when ACP is
    enabled, the requester is not sandboxed, and an ACP runtime backend is
    loaded. `acp.dispatch.enabled=false` pauses automatic ACP thread dispatch
    but does not hide or block explicit `sessions_spawn({ runtime: "acp" })`
    calls. It targets ACP harness ids such as `codex`, `claude`, `droid`,
    `gemini`, or `opencode`. Do not pass a normal OpenClaw config agent id
    from `agents_list` unless that entry is explicitly configured with
    `agents.entries.*.runtime.type="acp"`; otherwise use the default sub-agent
    runtime. When an OpenClaw agent is configured with
    `runtime.type="acp"`, OpenClaw uses `runtime.acp.agent` as the underlying
    harness id.

  </Accordion>
</AccordionGroup>
