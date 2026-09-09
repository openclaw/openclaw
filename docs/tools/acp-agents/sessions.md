---
summary: "Start ACP sessions from sessions_spawn or /acp spawn, with the parameter and mode reference"
title: "ACP agents sessions"
read_when:
  - You are starting an ACP session from an agent turn or from chat
  - You need the sessions_spawn parameter reference for runtime acp
  - You need the --bind and --thread mode tables
---

## Start ACP sessions

Two ways to start an ACP session:

<Tabs>
  <Tab title="From sessions_spawn">
    Use `runtime: "acp"` to start an ACP session from an agent turn or tool
    call.

    ```json
    {
      "task": "Open the repo and summarize failing tests",
      "runtime": "acp",
      "agentId": "codex",
      "thread": true,
      "mode": "session"
    }
    ```

    <Note>
    `runtime` defaults to `subagent`, so set `runtime: "acp"` explicitly for
    ACP sessions. If `agentId` is omitted, OpenClaw uses `acp.defaultAgent`
    when configured. `mode: "session"` requires `thread: true` to keep a
    persistent bound conversation.
    </Note>

  </Tab>
  <Tab title="From /acp command">
    Use `/acp spawn` for explicit operator control from chat.

    ```text
    /acp spawn codex --mode persistent --thread auto
    /acp spawn codex --mode oneshot --thread off
    /acp spawn codex --bind here
    /acp spawn codex --thread here
    ```

    Key flags:

    - `--mode persistent|oneshot`
    - `--bind here|off`
    - `--thread auto|here|off`
    - `--cwd <absolute-path>`
    - `--label <name>`

    See [Slash commands](/tools/slash-commands).

  </Tab>
</Tabs>

### `sessions_spawn` parameters

<ParamField path="task" type="string" required>
  Initial prompt sent to the ACP session.
</ParamField>
<ParamField path="runtime" type='"acp"' required>
  Must be `"acp"` for ACP sessions.
</ParamField>
<ParamField path="agentId" type="string">
  ACP target harness id. Falls back to `acp.defaultAgent` if set.
</ParamField>
<ParamField path="thread" type="boolean" default="false">
  Request thread binding flow where supported.
</ParamField>
<ParamField path="mode" type='"run" | "session"' default="run">
  `"run"` is one-shot; `"session"` is persistent. If `thread: true` and
  `mode` is omitted, OpenClaw may default to persistent behaviour per
  runtime path. `mode: "session"` requires `thread: true`.
</ParamField>
<ParamField path="cwd" type="string">
  Requested runtime working directory (validated by backend/runtime policy).
  If omitted, ACP spawn inherits the target agent workspace when configured;
  missing inherited paths fall back to backend defaults, while real access
  errors are returned.
</ParamField>
<ParamField path="label" type="string">
  Operator-facing label used in session/banner text.
</ParamField>
<ParamField path="resumeSessionId" type="string">
  Resume an existing ACP session instead of creating a new one. The agent
  replays its conversation history via `session/load`. Requires
  `runtime: "acp"`.
</ParamField>
<ParamField path="streamTo" type='"parent"'>
  `"parent"` streams initial ACP run progress summaries back to the requester
  session as system events. OpenClaw records the full relay history in the
  child agent's SQLite state and removes it with the child session. Parent
  progress streams show assistant commentary and ACP status progress by default unless
  `streaming.progress.commentary=false`. Discord parent progress requires an
  explicit `streaming.mode: "progress"`; unset Discord streaming stays quiet.
  Status progress still honors `acp.stream.tagVisibility`, so tags such as
  `plan` remain hidden unless explicitly enabled.
</ParamField>

ACP `sessions_spawn` runs use `agents.defaults.subagents.runTimeoutSeconds`
for their default child turn limit. The tool does not accept per-call
timeout overrides (`runTimeoutSeconds`/`timeoutSeconds` are rejected with a
config-the-default error).

<ParamField path="model" type="string">
  Explicit model override for the ACP child session. Codex ACP spawns
  normalize OpenAI refs such as `openai/gpt-5.4` to Codex ACP startup config
  before `session/new`; slash forms such as `openai/gpt-5.4/high` also set
  Codex ACP reasoning effort. When omitted, `sessions_spawn({ runtime: "acp" })`
  uses existing subagent model defaults (`agents.defaults.subagents.model` or
  `agents.entries.*.subagents.model`) when configured; otherwise it lets the ACP
  harness use its own default model. Other harnesses must advertise ACP model
  controls for an explicit selection. Without those controls, an explicit
  selection fails; an inherited default may be omitted so the harness can use
  its own default.
</ParamField>
<ParamField path="thinking" type="string">
  Explicit thinking/reasoning effort. For Codex ACP, `minimal` maps to low
  effort, `low`/`medium`/`high`/`xhigh` map directly, and `off` omits the
  reasoning-effort startup override. An explicit value takes precedence over
  a reasoning suffix in `model`, including `off`. When omitted, ACP spawns use existing
  subagent thinking defaults, the configured target agent's `thinkingDefault`, and per-model
  `agents.defaults.models["provider/model"].params.thinking` for the selected
  model.
</ParamField>

## Spawn bind and thread modes

<Tabs>
  <Tab title="--bind here|off">
    | Mode   | Behavior                                                               |
    | ------ | ----------------------------------------------------------------------- |
    | `here` | Bind the current active conversation in place; fail if none is active. |
    | `off`  | Do not create a current-conversation binding.                          |

    Notes:

    - `--bind here` is the simplest operator path for "make this channel or chat Codex-backed."
    - `--bind here` does not create a child thread.
    - `--bind here` is only available on channels that expose current-conversation binding support.
    - `--bind` and `--thread` cannot be combined in the same `/acp spawn` call.

  </Tab>
  <Tab title="--thread auto|here|off">
    | Mode   | Behavior                                                                                            |
    | ------ | ------------------------------------------------------------------------------------------------- |
    | `auto` | In an active thread: bind that thread. Outside a thread: create/bind a child thread when supported. |
    | `here` | Require current active thread; fail if not in one.                                                  |
    | `off`  | No binding. Session starts unbound.                                                                 |

    Notes:

    - On non-thread binding surfaces, default behavior is effectively `off`.
    - Thread-bound spawn requires channel policy support:
      - Discord/Telegram: `session.threadBindings.spawnSessions=true`
    - Use `--bind here` when you want to pin the current conversation without creating a child thread.

  </Tab>
</Tabs>
