---
summary: "Session permission modes, workspace boundaries, and escalation reviewers"
read_when:
  - Choosing a permission mode for an agent session
  - Understanding who reviews an exec escalation
  - Comparing session permissions with sandbox and tool policy
title: Session permission modes
---

Session permission modes set one session's filesystem boundary and exec escalation reviewer. The boundary is the session's recorded resolved `sessionRoot`, or the selected agent's resolved workspace when no root is recorded. The mode determines what may happen inside or outside that boundary.

| Mode        | Control UI label | Filesystem access                                         | Exec escalation reviewer                |
| ----------- | ---------------- | --------------------------------------------------------- | --------------------------------------- |
| `read-only` | **Read only**    | Reads under `sessionRoot`; managed mutation tools omitted | None; exec is denied                    |
| `guarded`   | **Ask me**       | Reads and writes under `sessionRoot`                      | A human after the allowlist fast path   |
| `workspace` | **Auto-review**  | Reads and writes under `sessionRoot`                      | LLM review: allow, deny, or ask a human |
| `full`      | **Full access**  | Unrestricted filesystem access                            | None                                    |

These tool-visibility and exec rules describe OpenClaw-managed tools. Native harnesses can retain their own tool surface under their permission controls; see [Codex runtime policy](/plugins/codex-harness-runtime).

Required workspace roots and sandbox restrictions still constrain file tools in `full` mode. Memory-flush runs expose only `read` and append-only `write`.

Control UI file previews follow this filesystem boundary; opening files outside the session root also requires current permission to start a turn in that session.

In `workspace` mode, an exec reviewer denial returns a reason to the agent without creating a human approval card. The agent must choose a materially safer alternative or ask the user; it must not work around the denial. Reviewer `ask` verdicts and review failures request human approval. Three consecutive gateway reviewer denials also escalate to a human. Existing command-binding checks and explicit human-approval requirements remain in force; see [Exec modes](/tools/exec#modes).

Gateway approval-backed commands bind every resolved command-segment executable before review and re-check it before launch: protected executables use resolved real-path identity only, while writable executables also use a content hash. Node identity checks cover local policy evaluation through dispatch, with a [remote shell-wrapper approval limitation](/tools/exec-approvals-advanced#interpreter%2Fruntime-commands). POSIX login or interactive shell wrappers skip auto-review and require human approval when binding succeeds; existing binding rejections remain denied. Their implicit startup files are outside operand binding.

`full` requires `operator.admin`. The other modes require `operator.write`.

## Session root and defaults

A permission mode can be set on any session. When a session has a recorded `sessionRoot`, that resolved path is its filesystem boundary. An explicit working directory and a managed worktree each pin their session's root. When no root is recorded, the boundary defaults to the selected agent's resolved workspace when the run is prepared.

Managed worktree sessions use the worktree checkout as `sessionRoot`. A nested working directory remains the runtime `cwd`, so relative paths start there while filesystem containment covers the whole checkout.

File tools recognize aliases of the session's trusted root and working directory, including absolute paths using those aliases. This does not expand the boundary: unrelated external symlinks pointing inward remain denied, as do symlinks and raw `symlink/..` traversal that escape the root. In `read-only` mode, OpenClaw-managed mutation tools remain omitted.

New sessions, including managed worktree sessions, inherit the configured global or per-agent tool/exec policy when no mode is specified. Exec and file-tool settings are independent: host `apply_patch` permits paths outside the workspace by default, consistently with unrestricted file tools. Set `tools.exec.applyPatch.workspaceOnly: true` or use a restricted session mode for containment. See [apply_patch containment](/tools/apply-patch#notes) for the file settings, session-mode precedence, and whole-agent worker defaults.

For attended sessions created directly by a profiled operator, you can opt in to
an explicit per-agent default with `agents.entries.<agentId>.newSessionPermissionMode`.
Choose `read-only`, `guarded`, `workspace`, or `full`. A configured `full` default
resolves to `workspace` for creators with `operator.write` but no `operator.admin`.
Explicit request modes win; an explicit `full` request still requires current
`operator.admin` authority. Existing sessions, forks,
catalog sessions, delegated callers, and autonomous runs do not receive this
creation-only default. Changing it does not alter already-created sessions.
The New Session picker displays this caller-specific mode in its **Default** label;
leaving Default selected lets the Gateway apply it with current authorization.
Existing sessions keep their tool-policy-based Default label and clearing behavior.

Creating a worktree pins the working directory without selecting a permission mode. Explicit modes and modes already saved on existing sessions remain unchanged.

When a session uses **Agent default**, the Control UI permission picker shows the agent's resolved posture when it matches a session mode, for example **Ask me** for `tools.exec.mode: "ask"` without a stricter host approval policy, and marks that mode's menu row **Default**. Resolution includes global settings, agent overrides, and host approval floors. **Default (Full Access)** also requires unrestricted Gateway-host execution to be available under effective tool policy and filesystem boundaries. Settings for a disabled tool grant no authority: `tools.exec.mode: "full"` cannot establish Full Access when `exec` is denied. Allowlist-only policy and non-equivalent `security`/`ask` pairs, including `ask: "always"`, keep the plain **Default** label. Agents whose sandbox configuration could apply to their sessions also keep plain **Default**, because effective policy cannot be stated at agent scope. The label is display metadata; execution checks the current run's authority. Selecting **Agent default** clears the session override; it does not save the displayed mode into the session.

## Delegated setup and repair

When a regular agent delegates a persistent change through its `openclaw` tool,
the host applies the requesting run's effective permission policy to the exact
proposed operation. Inferred and explicit Full Access have the same default:
permitted changes apply automatically. Inference requires effective unrestricted
execution on the Gateway host through a host-controlled execution path, with no
unaccounted-for restricting policy. Settings for unavailable tools, a remote node,
an exported tool catalog, or a requested native Full Access/bypass mode do not
establish that authority. Applicable execution hooks can restrict it even when
exec is configured as full with approvals off; hooks for unrelated tools do not.
Restricted or unknown Default configurations require human approval unless an
independent grant authorizes the change.

This rule applies across the OpenClaw runtime, Codex, Claude, and external CLI
backends. Backend identity alone supplies no grant. Current native integrations
do not certify all effective client-side restrictions, so unknown Default native
runs require exact approval for each persistent delegated change. Select
OpenClaw Full Access or use the existing standing delegation setting below to
avoid those repeated approvals. An allow-once decision authorizes only the exact
proposal; it does not implicitly save a permission mode or standing grant. If the
proposal explicitly changes `tools.openclaw.autoApproveChanges` or a per-agent
override, approving it saves that standing policy for future permitted changes.

Use [`tools.openclaw.autoApproveChanges`](/gateway/config-tools/built-in-tools#tools.openclaw)
globally or at `agents.entries.<agentId>.tools.openclaw.autoApproveChanges` to
control this standing authorization. The per-agent value overrides the global
default; omitted values inherit. `false` requires human approval even in Full
Access. `true` grants delegated administration within the existing boundaries.
When unset at both scopes, the Full Access default above applies.

An explicit Full Access selection or `autoApproveChanges: true` grants delegated
administration independently of direct tool access. It can permit changes that
enable host code execution, such as configuring services or installing plugins,
even when direct execution or file-editing tools are denied. To keep those changes
under human review, set `autoApproveChanges: false`.

Enabling or broadening this grant, removing an explicit `false`, or expanding it
to other agents requires direct operator administration or human approval for
the exact change. A model cannot automatically approve its own permission
increase. Delegation and child runs retain their restrictive inherited ceilings.

When approval is required, runs from messaging channels ask the
requesting chat for approval: native approval cards where the channel supports
them, otherwise a `/approve <id> allow-once|deny` reply. Webchat and terminal runs
decide in the Control UI or apps, which can also decide any chat's approval.
Free-text replies such as "yes" never authorize the change.
The requesting tool waits for the human decision and application outcome. Stopping
the run cancels its pending approval; approving later cannot revive that run.

Independent filesystem and sandbox boundaries, access to the `openclaw` tool,
and system-agent operation restrictions still apply. The host rechecks current
delegation authority immediately before each persistent effect, so revoking the
grant also stops automatic changes still being prepared. It also checks that the
requesting run and verified inference route remain valid. Interactive setup wizards and agent
handoffs still need a direct operator session. See
[OpenClaw operations and approval](/cli/openclaw#operations-and-approval).

## Change permissions during a task

Choose a mode from the chat composer's **Permissions** menu. On wider web composers, the picker shows the current mode beside its icon, including the resolved mode when using Default. Compact composers keep the icon-only control. The picker immediately shows the selected mode while the change settles, and temporarily blocks another selection for that session. Other clients see the mode after the Gateway publishes the updated session. If the change fails, the picker reconciles with the authoritative session state and shows an error; if that state cannot be refreshed yet, it keeps the optimistic selection until a fresh permission read or update for that session confirms the saved mode.

- **Codex:** OpenClaw interrupts the active native turn and stops its background terminals, then continues in the same conversation with the new permissions and an internal **Permission change** notice. It does not reset the conversation or replay the original request.
- **OpenClaw native runtime:** OpenClaw refreshes the active tool policy without restarting the conversation. Subsequent tool calls use the updated permissions.

Pending approvals from the old permissions are canceled, not granted. Changing permissions does not undo completed writes or other side effects. Commands and background processes that have already started are not rolled back.

Active CLI-backed runs and runs whose entire agent executes on a worker (`worker-turn`) do not support live permission changes. OpenClaw rejects the change before saving it. Stop the task, change permissions, then continue in the same session. Worker placements that run only remote commands (`remote-exec`) follow the behavior of their locally running agent runtime.

## Policy precedence and clamping

Session-wide exec policy belongs to the permission mode. When the mode is unset, normal global or per-agent configuration applies. `/exec security=... ask=...` applies only to its message and can only tighten an explicit session mode; `host` and `node` remain session placement defaults. See [Exec session overrides](</tools/exec#session-overrides-(%2Fexec)>).

Before resuming sessions after upgrading a store with legacy session exec policy, run `openclaw doctor --fix`; the runtime no longer reads that policy. Missing policy values inherit the layered global and per-agent exec policy. When historical sandbox availability is unknown, migration uses the stricter sandbox base for automatic host selection. Restrictive policies migrate without broadening exec access to `read-only` or `guarded`. Existing permission modes remain unchanged. Legacy full-access policy is removed with a notice so configuration applies, never converted into a `full` permission grant.

The retired `execSecurity` and `execAsk` fields remain in the wire schemas for `sessions.patch` and `sessions.patchMany`. Requests containing either field, including `null`, are rejected with `INVALID_REQUEST` and guidance to set `permissionMode` (`read-only`, `guarded`, `workspace`, or `full`) or use `/exec` for one run. Neither field is stored as runtime session policy.

An explicit `full` mode is the admin-authorized exception to host approval-file floors: its OpenClaw exec policy remains `full` with approvals off unless a turn-scoped override tightens it. Approval-file floors continue to tighten config-driven exec policy, unset modes, and every non-full session mode. Tightening a full session's security restores those floors; tightening only `ask` does not. Sandbox restrictions and tool allow/deny policy remain independent, and a harness may clamp an unsupported mode to a compatible safer policy tuple. Codex also continues to honor externally enforced `requirements.toml` constraints.

For the independent sandbox, tool-policy, and elevated-exec controls, see [Sandbox vs tool policy vs elevated](/gateway/sandbox-vs-tool-policy-vs-elevated).
