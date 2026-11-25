---
summary: "How OpenClaw applies named prompt and tool behavior"
title: "Agent Profiles"
read_when:
  - You want a smaller tool surface and bounded workspace context for a model
  - You need to pin or override a profile
  - You are migrating from experimental.localModelLean
---

Agent Profiles are named, validated sets of agent-harness behavior. OpenClaw
applies the profile you select before it builds the workspace context and the
tool surface.

Agent Profiles do not select a model or change provider transport, credentials,
context-window settings, or local serving configuration.

## Ownership

OpenClaw uses types from the `agentprofiles` package for the portable resource
envelope and checks its built-in profiles with the package's validator in tests.
The portable validator treats domain-named sections as opaque JSON objects. It
does not define or validate OpenClaw fields.

OpenClaw owns `spec["openclaw.ai"]`. OpenClaw strictly validates this section
and resolves it with OpenClaw-owned defaults and inheritance rules. The resolved
values select OpenClaw runtime behavior:

```yaml
spec:
  common: {}
  openclaw.ai:
    toolProfile: compact
```

The OpenClaw adapter stays in the OpenClaw repository. There is no global
adapter registry or separate adapter package. Portable profile resolution and
OpenClaw extension resolution remain separate.

## Built-in profiles

| Profile          | Parent          | Initial behavior                                                 |
| ---------------- | --------------- | ---------------------------------------------------------------- |
| `openclaw/base`  | none            | Standard OpenClaw behavior and fallback                          |
| `openclaw/small` | `openclaw/base` | Composed prompt with bounded workspace context and compact tools |

## Selection

Without configuration, every agent uses `openclaw/base`, which keeps standard
OpenClaw behavior. Set `agents.defaults.agentProfileId` (or `agentProfileId` on
one agent) to select a profile. OpenClaw uses this order:

1. Explicit per-agent profile.
2. Explicit default profile.
3. `openclaw/base` when neither is set.

The `--agent-profile` flag accepts the same profile ids for one run.

## Configuration

Select the small profile for every agent:

```json5
{
  agents: {
    defaults: {
      agentProfileId: "openclaw/small",
    },
  },
}
```

Select it for one agent and keep the base profile for the rest:

```json5
{
  agents: {
    entries: {
      local: {
        model: "llama-cpp/qwen3.6-35b-a3b",
        agentProfileId: "openclaw/small",
      },
    },
  },
}
```

## Small profile behavior

`openclaw/small` uses the normal OpenClaw prompt composer. It does not replace
the complete system prompt. Its OpenClaw extension limits the content OpenClaw
prepares from `AGENTS.md`, `SOUL.md`, `IDENTITY.md`, and `USER.md` to 11,500
characters together, which is a rough 2,900-token proxy at four
characters per token. Memory and other injected files keep the operator
limits. `AGENTS.md` may use up to 7,500 of them, enough to keep a
typical 7,000-character file whole; a smaller cap makes the trim keep a digest
and drop the file's tail. This is not an exact tokenizer limit and does not include
conversation history, tool schemas, skills, memory, or generated prompt text.
Project-local instructions that Codex loads natively, including `AGENTS.md`,
are also outside these per-file and aggregate limits. Codex uses its own
project-document settings for those instructions.

The profile keeps `IDENTITY.md` available so the model receives the configured
assistant identity. An `IDENTITY.md` above its 1,024-character limit, such as
the stock seed template, is truncated with a visible marker rather than
stopping the turn. It applies per-section limits first and then divides the
remaining aggregate budget proportionally across the sections. Existing
operator and security limits remain upper ceilings.

OpenClaw owns the strict `spec["openclaw.ai"].prompt.workspaceContext` schema,
inheritance, allocation, and diagnostics. See [Agent workspace](/concepts/agent-workspace) and
[workspace and bootstrap configuration](/gateway/config-agents/workspace-and-bootstrap).

The profile also removes heavyweight optional tools: `browser`, `message`,
`image_generate`, `music_generate`, `video_generate`, `tts`, and `pdf`. It keeps
`automations`: a model without the scheduler tends to fake a reminder through a
shell command and then report it as scheduled. `message` stays available when it
owns the visible reply for the run.

The profile filters these tools before OpenClaw builds its Tool Search catalog.
A tool the profile removes is not discoverable or callable through Tool Search.
An explicit allow rule or delivery requirement can preserve a tool, subject to
normal tool policy. Where OpenClaw Tool Search applies, the profile defaults to
bounded structured search (`tool_search`, `tool_describe`, and `dispatch_action`)
when `tools.toolSearch` is unset. Explicit Tool Search configuration takes
precedence over that default. The worker wire field that carries the compact
directory choice keeps its name, `toolSearchDirectoryLean`, so gateways and
workers on different versions keep working.

The profile keeps `exec` directly visible. Normal tool policy, sandboxing, and
exec approvals still apply.

## Diagnostics

`/context detail` and `/context json` include the selected profile id and
selection source in the stored system-prompt report. They also show the direct
tool schemas used for the request. Detailed context reports show the resolved workspace-context budget and per-section
allocation or truncation status. Reports do not include private message or
workspace-file content.

## Legacy migration

Run `openclaw doctor --fix` to migrate the retired
`agents.defaults.experimental.localModelLean` key and its per-agent equivalents:

| Legacy value                               | Result                             |
| ------------------------------------------ | ---------------------------------- |
| `true` at any scope                        | `agentProfileId: "openclaw/small"` |
| `false` at defaults                        | key removed                        |
| `false` on an agent under a `true` default | `agentProfileId: "openclaw/base"`  |
| `false` on an agent otherwise              | key removed                        |

A legacy `true` becomes an explicit `openclaw/small`. An explicit `agentProfileId` at the same scope always wins and the
legacy key is dropped. The CLI flag `--local-model-lean` remains a deprecated alias for
`--agent-profile openclaw/small`.

## Related

- [Local models](/gateway/local-models)
- [Context](/concepts/context)
- [Tool Search](/tools/tool-search)
