---
summary: "A checklist for when active memory does not run, and the common recall failures with their causes."
read_when:
  - Active memory is not showing up where you expect
  - Recall is slow, empty, inconsistent, or policy-disabled
title: "Troubleshooting active memory"
---

## Debugging

If active memory is not showing up where you expect:

1. Confirm the plugin is enabled under `plugins.entries.active-memory.enabled`.
2. For Remember across conversations, confirm the agent's effective
   `memory.search.rememberAcrossConversations` setting is enabled, run
   `openclaw doctor` to verify the current memory provider supports protected
   transcript recall, and confirm `config.toolsAllow` includes `memory_search`
   when explicitly configured. For advanced Active Memory, confirm the agent ID
   is listed in `config.agents`.
3. Confirm you are testing through an eligible interactive persistent conversation.
4. Remember that groups and channels never use cross-conversation transcript recall.
5. Turn on `config.logging: true` and watch the gateway logs.
6. Verify memory search itself works with `openclaw status --deep`.

If memory hits are noisy, tighten `maxSummaryChars`. If active memory is too
slow, lower `queryMode`, lower `timeoutMs`, or reduce recent turn counts and
per-turn char caps.

## Common issues

Advanced Active Memory rides on the configured memory plugin's recall
pipeline, so most recall surprises are embedding-provider problems, not
active-memory bugs. The default `memory-core` path uses `memory_search` and
`memory_get`; the `memory-lancedb` slot uses `memory_recall`. If you use another
memory plugin, confirm `config.toolsAllow` names the tools that plugin actually
registers. Remember across conversations is narrower: the current memory
provider must support OpenClaw's protected same-agent/private-session recall
path.

<AccordionGroup>
  <Accordion title="Registered recall tools return `status=policy-disabled`">
    This status means none of the configured recall tools remain in the parent
    agent's authorized tool surface. Active Memory skips the blocking sub-agent
    and the main reply continues without recalled context.

    - Check the selected agent's profile and explicit `tools.alsoAllow` grants.
      Under a restrictive profile, listing plugin tools in `config.toolsAllow`
      alone does not authorize them. Use the scoped [Lossless Claw example](/concepts/active-memory/memory-tools#lossless-claw).
    - Check explicit denies and provider, agent, and sandbox tool policies.
      `alsoAllow` extends the profile; it does not override those restrictions.
      Provider-specific profiles have their own `alsoAllow` configuration.
    - Confirm that `config.toolsAllow` contains the intended concrete recall
      names. Active Memory can use only the intersection of this list and the
      parent agent's effective tools. Keep `memory_search` when using Remember
      across conversations.
    - Use `openclaw plugins inspect lossless-claw --runtime --json` to check
      registration. A tool listed there is registered, but that output does not
      prove the parent agent or Active Memory is authorized to call it.

  </Accordion>

  <Accordion title="Embedding provider switched or stopped working">
    If `memory.search.provider` is unset, OpenClaw uses OpenAI embeddings. Set
    `memory.search.provider` explicitly for Bedrock, DeepInfra, Gemini, GitHub
    Copilot, LM Studio, local, Mistral, Ollama, Voyage, or OpenAI-compatible
    embeddings. If the configured provider cannot run, `memory_search` may
    degrade to lexical-only retrieval; runtime failures after a provider is
    already selected do not fall back automatically.

    Set an optional `memory.search.fallback` only when you want a deliberate
    single fallback. See [Memory Search](/concepts/memory-search) for the full
    list of providers and examples.

  </Accordion>

  <Accordion title="Recall feels slow, empty, or inconsistent">
    - Turn on `/trace on` to surface the plugin-owned Active Memory debug
      summary in the session.
    - Turn on `/verbose on` to also see the `🧩 Active Memory: ...` status line
      after each reply.
    - Watch gateway logs for `active-memory: ... start|done`,
      `memory sync failed (search-bootstrap)`, or provider embedding errors.
    - Run `openclaw status --deep` to inspect the memory-search backend and
      index health.
    - If you use `ollama`, confirm the embedding model is installed
      (`ollama list`).
  </Accordion>

  <Accordion title="First recall after gateway restart returns `status=timeout`">
    On v2026.5.2 and later, if cold-start setup (model warm-up + embedding
    index load) has not finished by the time the first recall fires, the run
    can hit the configured `timeoutMs` budget and return `status=timeout`
    with empty output. Gateway logs show `active-memory timeout after Nms`
    around the first eligible reply after a restart.

    See [Cold-start grace](/concepts/active-memory/recommended-setup#cold-start-grace) under Recommended setup for the
    recommended `setupGraceTimeoutMs` value.

  </Accordion>
</AccordionGroup>
