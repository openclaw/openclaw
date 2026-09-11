---
summary: "Escape hatches for thinking, fast mode, and the sub-agent prompt, plus exporting blocking sub-agent transcripts for debugging."
read_when:
  - You need to override the sub-agent prompt or thinking level
  - You want blocking sub-agent transcripts on disk
title: "Advanced overrides and transcripts"
---

## Advanced escape hatches

Not part of the recommended setup.

`config.thinking` overrides the sub-agent's thinking level (default `"off"`,
since active memory runs in the reply path and extra thinking time directly
adds user-visible latency):

```json5
thinking: "medium" // default: "off"
```

`config.fastMode` overrides fast mode only for the blocking memory sub-agent.
Use `true`, `false`, or `"auto"`; leave it unset to inherit the normal
agent, session, and model defaults. `"auto"` uses the recall model's configured
`fastAutoOnSeconds` cutoff:

```json5
fastMode: true
```

`config.promptAppend` adds operator instructions after the default prompt
and before the conversation context — pair it with a custom `toolsAllow` when
a non-core memory plugin needs specific tool order or query shaping:

```json5
promptAppend: "Prefer stable long-term preferences over one-off events."
```

`config.promptOverride` replaces the default prompt entirely (conversation
context is still appended afterward). Not recommended unless deliberately
testing a different recall contract — the default prompt is tuned to return
either `NONE` or compact user-fact context for the main model:

```json5
promptOverride: "You are a memory search agent. Return NONE or one compact user fact."
```

## Transcript persistence

Blocking sub-agent runs keep their runtime transcript in the agent's SQLite
store. By default, OpenClaw removes the temporary sub-agent session rows after
the run finishes and does not create a JSONL file.

If cleanup crosses the recall deadline, a completed summary grounded in memory
results can still be recovered as `timeout_partial` after cleanup settles.
This works with temporary transcripts; `persistTranscripts` only controls
debugging exports. Failed runs, failed cleanup, and unavailable memory results
remain ineligible for timeout recovery. Recovered summaries are not cached or
stored in session debug lines.

To export those transcripts as JSONL artifacts for debugging:

```json5
{
  plugins: {
    entries: {
      "active-memory": {
        enabled: true,
        config: {
          agents: ["main"],
          persistTranscripts: true,
          transcriptDir: "active-memory",
        },
      },
    },
  },
}
```

Exported transcript artifacts go under the OpenClaw state directory, in a
plugin-owned, per-agent directory separate from active runtime state:

```text
<state-dir>/plugins/active-memory/transcripts/agents/<encoded-agent>/active-memory/<blocking-memory-sub-agent-session-id>.jsonl
```

Agent ids are URI-encoded in this path: for example, `support/agent` becomes
`support%2Fagent`. Change the final artifact subdirectory with
`config.transcriptDir`. Use this carefully: exports can accumulate quickly on busy
sessions, `full` query mode duplicates a lot of conversation context, and these
artifacts contain hidden prompt context plus recalled memories.
