---
summary: "Two ways to turn active memory on: the per-agent rememberAcrossConversations product setting, and the advanced plugin quick start."
read_when:
  - You want cross-conversation recall for a personal agent
  - You want a safe advanced starter config for the plugin
title: "Enabling active memory"
---

## Remember across conversations

For a personal or fully trusted agent, enable bounded recall across its other
private conversations with one per-agent setting:

```json5
{
  agents: {
    entries: {
      personal: {
        memory: {
          search: {
            rememberAcrossConversations: true,
          },
        },
      },
    },
  },
}
```

The setting defaults on for personal installs: global `session.dmScope` must be
unset or `"main"`, and no binding may override `session.dmScope`. Any configured
DM isolation defaults it off. An explicit `true` or `false` always wins. When
enabled, OpenClaw indexes that agent's session transcripts and runs an Active
Memory retrieval pass before eligible private replies. The pass can read
relevant transcript excerpts from the same agent's other private conversations.
It excludes the conversation already being answered.

The privacy boundary is fixed:

- private direct and persistent explicit UI conversations can recall one another
- groups and channels are neither recall sources nor recall destinations
- another agent's transcripts are never eligible
- unknown or archived transcripts without enough conversation metadata are rejected

This does not merge transcripts, change session keys or delivery routes, widen
`tools.sessions.visibility`, or grant broader `sessions_*` tool access. Shared
workspace memory (`MEMORY.md` and `memory/*.md`) keeps its existing behavior.

Active Memory must remain enabled. Retrieval adds a bounded blocking step to
eligible replies. An intentional no-intent skip or an unavailable search adds a
short hidden outcome note instead of recalled transcript context. This tells
the main model that recall did not run or could not finish without exposing
provider errors. Timeout and empty results keep their existing behavior.
OpenClaw's built-in memory provider supports this protected transcript-recall
path. Other memory providers keep their own recall behavior but do not
automatically receive private transcript authorization. `openclaw doctor`
reports an unsupported provider or missing `memory_search` tool.

## Advanced Active Memory quick start

Paste into `openclaw.json` for an advanced safe default: plugin on, scoped to
`main`, direct-message sessions only, model inherited from the session.

```json5
{
  plugins: {
    entries: {
      "active-memory": {
        enabled: true,
        config: {
          enabled: true,
          mode: "escalate",
          agents: ["main"],
          allowedChatTypes: ["direct"],
          modelFallback: "google/gemini-3-flash",
          queryMode: "recent",
          promptStyle: "balanced",
          timeoutMs: 15000,
          maxSummaryChars: 220,
          persistTranscripts: false,
          logging: true,
        },
      },
    },
  },
}
```

`plugins.entries.*` (including `active-memory.config`) is in the [no-restart
config category](/gateway/configuration#what-hot-applies-vs-what-needs-a-restart):
the Gateway reloads the plugin runtime automatically and no manual restart is
needed. If you want to force a full restart anyway, run:

```bash
openclaw gateway restart
```

To inspect it live in a conversation:

```text
/verbose on
/trace on
```

What the key fields do:

- `plugins.entries.active-memory.enabled: true` turns the plugin on
- `config.mode: "escalate"` runs deep recall only for recall intent without a strong deterministic hit
- `config.escalationDecision: true` (optional) asks the agent's [Decision model](/concepts/decision-models) for that intent decision
- `config.agents: ["main"]` opts only the `main` agent in
- `config.allowedChatTypes: ["direct"]` scopes it to direct-message sessions (opt in groups/channels explicitly)
- `config.model` (optional) pins a dedicated recall model; unset inherits the current session model
- `config.modelFallback` is used only when no explicit or inherited model resolves
- `config.fastMode` optionally overrides fast mode for recall without changing the main agent
- `config.promptStyle: "balanced"` is the default for `recent` mode
- active memory still runs only for eligible interactive persistent chat sessions (see [When it runs](/concepts/active-memory/how-it-works#when-it-runs))

### Decision model escalation

In `mode: "escalate"`, Active Memory can ask the agent's
[Decision model](/concepts/decision-models), with
[Decision assistance](/concepts/experimental-features) enabled, whether a turn needs deep recall
instead of relying only on the built-in intent matcher:

```json5
{
  agents: {
    defaults: {
      experimental: { decisionAssistance: true },
      decisionModel: "onnx/gliclass-edge-v3.0",
    },
  },
  plugins: {
    entries: {
      "active-memory": {
        enabled: true,
        config: { mode: "escalate", escalationDecision: true },
      },
    },
  },
}
```

Active Memory asks one Boolean question (`deepRecall`) for purpose
`active-memory/escalation`, only after deterministic recall has not produced a
strong hit. A `probabilityTrue` of at least 0.5 runs deep recall; a lower value
skips it. The request carries only the bounded latest user message and search
query, and it must answer within the remaining preflight budget (at most one
second); a late answer never replaces the matcher. Without Decision assistance
or a selected Decision model, and when the model is unavailable, fails, times
out, or returns an invalid answer, the built-in intent matcher decides as
before. Active Memory keeps rechecking both opt-ins while a question is pending: withdrawing either cancels the request before it is sent when possible and discards any answer that still arrives. Modes `"off"` and `"always"` never ask. Hosted Decision models receive
that bounded text and may charge for each evaluation; prefer a local model for
per-turn use.
